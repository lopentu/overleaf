package uk.ac.ic.wlgitbridge.bridge;

import static org.junit.Assert.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import jakarta.servlet.http.HttpServletRequest;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.FilterInputStream;
import java.io.FilterOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.io.UncheckedIOException;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import org.eclipse.jgit.api.Git;
import org.eclipse.jgit.api.ResetCommand;
import org.eclipse.jgit.lib.ObjectId;
import org.eclipse.jgit.lib.ObjectIdRef;
import org.eclipse.jgit.lib.Ref;
import org.eclipse.jgit.lib.Repository;
import org.eclipse.jgit.storage.file.FileRepositoryBuilder;
import org.eclipse.jgit.transport.PacketLineOut;
import org.eclipse.jgit.transport.PreReceiveHook;
import org.eclipse.jgit.transport.ReceiveCommand;
import org.eclipse.jgit.transport.ReceivePack;
import org.junit.After;
import org.junit.Before;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;
import uk.ac.ic.wlgitbridge.application.config.Config;
import uk.ac.ic.wlgitbridge.bridge.db.DBStore;
import uk.ac.ic.wlgitbridge.bridge.gc.GcJob;
import uk.ac.ic.wlgitbridge.bridge.lock.LockGuard;
import uk.ac.ic.wlgitbridge.bridge.repo.FSGitRepoStore;
import uk.ac.ic.wlgitbridge.bridge.resource.ResourceCache;
import uk.ac.ic.wlgitbridge.bridge.snapshot.SnapshotApiFacade;
import uk.ac.ic.wlgitbridge.bridge.swap.job.SwapJob;
import uk.ac.ic.wlgitbridge.bridge.swap.store.SwapStore;
import uk.ac.ic.wlgitbridge.data.CandidateSnapshot;
import uk.ac.ic.wlgitbridge.data.ProjectLockImpl;
import uk.ac.ic.wlgitbridge.git.handler.WLReceivePackFactory;
import uk.ac.ic.wlgitbridge.snapshot.push.PushResult;

/** Exercise the pinned JGit receive pipeline and real Bridge/project lock, not just hook mocks. */
public class ReceivePackConcurrencyTest {
  private static final String PROJECT = "000000000000000000000000";
  private static final String REF = "refs/heads/main";

  @Rule public TemporaryFolder temporary = new TemporaryFolder();
  private FSGitRepoStore store;
  private Repository repository;
  private Git git;
  private Bridge bridge;
  private ObjectId base;
  private ObjectId winner;
  private ObjectId loser;
  private final AtomicInteger mutations = new AtomicInteger();
  private final AtomicInteger version = new AtomicInteger();
  private final Map<ReceivePack, List<ReceiveCommand>> capturedCommands = new HashMap<>();
  private Runnable afterMutation = () -> {};
  private final AtomicReference<Map<String, String>> apiFiles =
      new AtomicReference<>(Map.of("base.tex", "base\n"));

  @Before
  public void setup() throws Exception {
    store = new FSGitRepoStore(temporary.newFolder("store").getAbsolutePath(), Optional.empty());
    DBStore db = mock(DBStore.class);
    when(db.getProjectNames()).thenReturn(List.of(PROJECT));
    when(db.getLatestVersionForProject(PROJECT)).thenAnswer(invocation -> version.get());
    SnapshotApiFacade api = mock(SnapshotApiFacade.class);
    bridge =
        new Bridge(
            new Config(0, "", 0, "", null, "", "", "", null, false, null, null, null, 0),
            new ProjectLockImpl(),
            store,
            db,
            mock(SwapStore.class),
            mock(SwapJob.class),
            mock(GcJob.class),
            api,
            mock(ResourceCache.class));
    PushResult accepted = mock(PushResult.class);
    when(accepted.wasSuccessful()).thenReturn(true);
    when(api.push(any(), any(CandidateSnapshot.class), anyString()))
        .thenAnswer(
            invocation -> {
              CandidateSnapshot candidate = invocation.getArgument(1);
              String key = invocation.getArgument(2);
              Map<String, String> next = new LinkedHashMap<>();
              for (JsonElement element :
                  candidate.getJsonRepresentation(key).getAsJsonObject().getAsJsonArray("files")) {
                JsonObject file = element.getAsJsonObject();
                String name = file.get("name").getAsString();
                if (file.has("url")) {
                  String url = file.get("url").getAsString();
                  String identifier = url.substring(url.lastIndexOf('/') + 1, url.indexOf('?'));
                  next.put(
                      name,
                      Files.readString(
                          store
                              .getRootDirectory()
                              .toPath()
                              .resolve(".wlgb/atts/" + PROJECT + "/" + identifier)));
                } else {
                  next.put(name, apiFiles.get().get(name));
                }
              }
              apiFiles.set(Map.copyOf(next));
              mutations.incrementAndGet();
              bridge.postbackReceivedSuccessfully(PROJECT, key, version.incrementAndGet());
              afterMutation.run();
              return accepted;
            });
    repository = store.initRepo(PROJECT).getJGitRepository();
    repository.getConfig().setBoolean("receive", null, "autogc", false);
    repository.getConfig().save();
    git = new Git(repository);
    base = commit("base.tex", "base\n");
    winner = commit("winner.tex", "winner\n");
    git.reset().setMode(ResetCommand.ResetType.HARD).setRef(base.name()).call();
    loser = commit("loser.tex", "loser\n");
    git.reset().setMode(ResetCommand.ResetType.HARD).setRef(base.name()).call();
  }

  @After
  public void close() {
    if (bridge != null) bridge.doShutdown();
    if (git != null) git.close();
  }

  @Test
  public void staleAdvertisedPushMustNotMutateSnapshotAfterWinnerRefUpdate() throws Exception {
    CountDownLatch validated = new CountDownLatch(1);
    CountDownLatch continueLoser = new CountDownLatch(1);
    ExecutorService executor = Executors.newSingleThreadExecutor();
    try (Repository loserRepository =
        new FileRepositoryBuilder().setWorkTree(repository.getWorkTree()).build()) {
      loserRepository.exactRef(REF); // Prime a distinct ref database before the winner updates it.
      ReceivePack second = receivePack(loserRepository);
      PreReceiveHook delegate = second.getPreReceiveHook();
      second.setPreReceiveHook(
          (pack, commands) -> {
            validated.countDown();
            await(continueLoser);
            delegate.onPreReceive(pack, commands);
          });
      Future<?> pending =
          executor.submit(
              () -> {
                second.receive(
                    input(Map.of(REF, loser), false),
                    new ByteArrayOutputStream(),
                    new ByteArrayOutputStream());
                return null;
              });
      assertTrue(
          "loser did not pass initial JGit validation", validated.await(10, TimeUnit.SECONDS));
      ReceivePack first = receivePack(repository);
      first.receive(
          input(Map.of(REF, winner), false),
          new ByteArrayOutputStream(),
          new ByteArrayOutputStream());
      assertEquals(1, capturedCommands.get(first).size());
      assertEquals(ReceiveCommand.Result.OK, capturedCommands.get(first).get(0).getResult());
      continueLoser.countDown();
      pending.get(10, TimeUnit.SECONDS);
      assertEquals(1, capturedCommands.get(second).size());
      ReceiveCommand.Result rejected = capturedCommands.get(second).get(0).getResult();
      assertEquals("loser=" + rejected + "; API mutations=" + mutations.get(), 1, mutations.get());
      assertEquals(ReceiveCommand.Result.REJECTED_NONFASTFORWARD, rejected);
      repository.getRefDatabase().refresh();
      assertEquals(winner, repository.exactRef(REF).getObjectId());
      assertEquals(Map.of("base.tex", "base\n", "winner.tex", "winner\n"), apiFiles.get());
    } finally {
      continueLoser.countDown();
      executor.shutdownNow();
      assertTrue(executor.awaitTermination(10, TimeUnit.SECONDS));
    }
  }

  @Test
  public void nonAtomicMixedCommandsRejectBeforeSnapshotMutation() throws Exception {
    rejectMixedBatch(false);
  }

  @Test
  public void atomicMixedCommandsRejectBeforeSnapshotMutation() throws Exception {
    rejectMixedBatch(true);
  }

  @Test
  public void standardReceiveFinallyReleasesGuardAfterHookThrows() throws Exception {
    hookFailure(false);
  }

  @Test
  public void propagatingReceiveFinallyReleasesGuardAfterHookThrows() throws Exception {
    hookFailure(true);
  }

  private void hookFailure(boolean propagating) throws Exception {
    ReceivePack pack = receivePack(repository);
    PreReceiveHook delegate = pack.getPreReceiveHook();
    pack.setPreReceiveHook(
        (receive, commands) -> {
          delegate.onPreReceive(receive, commands);
          throw new IllegalStateException("synthetic hook failure");
        });
    assertThrows(
        IllegalStateException.class,
        () ->
            receive(
                pack, input(Map.of(REF, winner), false), new ByteArrayOutputStream(), propagating));
    assertEquals(1, mutations.get());
    repository.getRefDatabase().refresh();
    assertEquals(base, repository.exactRef(REF).getObjectId());
    assertLockAvailable(PROJECT);
  }

  @Test
  public void genuineRefLockFailureRemainsFailureAndReleasesGuard() throws Exception {
    java.nio.file.Path refLock = repository.getDirectory().toPath().resolve(REF + ".lock");
    afterMutation =
        () -> {
          try {
            Files.writeString(refLock, "synthetic external ref lock");
          } catch (IOException error) {
            throw new UncheckedIOException(error);
          }
        };
    ReceivePack pack = receivePack(repository);
    try {
      receive(pack, input(Map.of(REF, winner), false), new ByteArrayOutputStream(), true);
      assertEquals(
          ReceiveCommand.Result.LOCK_FAILURE, capturedCommands.get(pack).get(0).getResult());
      assertEquals(1, mutations.get());
      repository.getRefDatabase().refresh();
      assertEquals(base, repository.exactRef(REF).getObjectId());
      assertLockAvailable(PROJECT);
    } finally {
      Files.deleteIfExists(refLock);
    }
  }

  @Test
  public void repositoryReplacementRejectsBeforeSnapshotMutation() throws Exception {
    ReceivePack pack = receivePack(repository);
    java.nio.file.Path original = repository.getDirectory().toPath();
    java.nio.file.Path moved = original.resolveSibling("saved-repository");
    Files.move(original, moved);
    Files.createSymbolicLink(original, moved.getFileName());
    receive(pack, input(Map.of(REF, winner), false), new ByteArrayOutputStream(), true);
    assertEquals(0, mutations.get());
    assertEquals(
        ReceiveCommand.Result.REJECTED_OTHER_REASON, capturedCommands.get(pack).get(0).getResult());
    assertLockAvailable(PROJECT);
  }

  @Test
  public void slowPackInputDoesNotHoldProjectGuard() throws Exception {
    stalledStream(true);
  }

  @Test
  public void slowStatusOutputDoesNotHoldProjectGuard() throws Exception {
    stalledStream(false);
  }

  @Test
  public void blockedBatchErrorOutputDoesNotHoldGuardOrLeavePendingCommands() throws Exception {
    blockedErrorOutput(false);
  }

  @Test
  public void blockedPushErrorOutputDoesNotHoldGuardOrLeavePendingCommands() throws Exception {
    blockedErrorOutput(true);
  }

  private void blockedErrorOutput(boolean pushError) throws Exception {
    CountDownLatch stalled = new CountDownLatch(1);
    CountDownLatch resume = new CountDownLatch(1);
    AtomicBoolean first = new AtomicBoolean(true);
    OutputStream messages =
        new FilterOutputStream(new ByteArrayOutputStream()) {
          @Override
          public void write(byte[] bytes, int offset, int length) throws IOException {
            if (first.getAndSet(false)) {
              stalled.countDown();
              await(resume);
            }
            out.write(bytes, offset, length);
          }
        };
    if (pushError)
      afterMutation =
          () -> {
            throw new IllegalStateException("synthetic API error");
          };
    Map<String, ObjectId> updates = new LinkedHashMap<>();
    updates.put(REF, winner);
    if (!pushError) updates.put("refs/heads/foreign", winner);
    ReceivePack pack = receivePack(repository);
    ExecutorService executor = Executors.newSingleThreadExecutor();
    try {
      Future<?> pending =
          executor.submit(
              () -> {
                pack.receiveWithExceptionPropagation(
                    input(updates, false), new ByteArrayOutputStream(), messages);
                return null;
              });
      assertTrue("error output did not block", stalled.await(10, TimeUnit.SECONDS));
      assertEquals(pushError ? 1 : 0, mutations.get());
      assertTrue(
          "error output must follow whole-batch rejection",
          capturedCommands.get(pack).stream()
              .allMatch(
                  command ->
                      command.getResult() != ReceiveCommand.Result.NOT_ATTEMPTED
                          && command.getResult() != ReceiveCommand.Result.OK));
      assertLockAvailable(PROJECT);
      resume.countDown();
      pending.get(10, TimeUnit.SECONDS);
      repository.getRefDatabase().refresh();
      assertEquals(base, repository.exactRef(REF).getObjectId());
    } finally {
      resume.countDown();
      executor.shutdownNow();
      assertTrue(executor.awaitTermination(10, TimeUnit.SECONDS));
    }
  }

  private void stalledStream(boolean stallInput) throws Exception {
    CountDownLatch stalled = new CountDownLatch(1);
    CountDownLatch resume = new CountDownLatch(1);
    AtomicBoolean first = new AtomicBoolean(true);
    InputStream source = input(Map.of(REF, winner), false);
    OutputStream destination = new ByteArrayOutputStream();
    if (stallInput) {
      source =
          new FilterInputStream(source) {
            @Override
            public int read(byte[] bytes, int offset, int length) throws IOException {
              if (first.getAndSet(false)) {
                stalled.countDown();
                await(resume);
              }
              return super.read(bytes, offset, length);
            }
          };
    } else {
      destination =
          new FilterOutputStream(destination) {
            @Override
            public void write(byte[] bytes, int offset, int length) throws IOException {
              if (first.getAndSet(false)) {
                stalled.countDown();
                await(resume);
              }
              super.write(bytes, offset, length);
            }
          };
    }
    InputStream input = source;
    OutputStream output = destination;
    ReceivePack pack = receivePack(repository);
    ExecutorService executor = Executors.newSingleThreadExecutor();
    try {
      Future<?> pending =
          executor.submit(
              () -> {
                receive(pack, input, output, true);
                return null;
              });
      assertTrue(stalled.await(10, TimeUnit.SECONDS));
      assertLockAvailable(PROJECT);
      resume.countDown();
      pending.get(10, TimeUnit.SECONDS);
      assertEquals(ReceiveCommand.Result.OK, capturedCommands.get(pack).get(0).getResult());
    } finally {
      resume.countDown();
      executor.shutdownNow();
      assertTrue(executor.awaitTermination(10, TimeUnit.SECONDS));
    }
  }

  @Test
  public void separateProjectGuardRemainsAvailableDuringSnapshotPush() throws Exception {
    CountDownLatch entered = new CountDownLatch(1);
    CountDownLatch resume = new CountDownLatch(1);
    afterMutation =
        () -> {
          entered.countDown();
          await(resume);
        };
    ReceivePack pack = receivePack(repository);
    ExecutorService executor = Executors.newSingleThreadExecutor();
    try {
      Future<?> pending =
          executor.submit(
              () -> {
                receive(pack, input(Map.of(REF, winner), false), new ByteArrayOutputStream(), true);
                return null;
              });
      assertTrue(entered.await(10, TimeUnit.SECONDS));
      assertLockAvailable("111111111111111111111111");
      resume.countDown();
      pending.get(10, TimeUnit.SECONDS);
      assertEquals(ReceiveCommand.Result.OK, capturedCommands.get(pack).get(0).getResult());
    } finally {
      resume.countDown();
      executor.shutdownNow();
      assertTrue(executor.awaitTermination(10, TimeUnit.SECONDS));
    }
  }

  private void assertLockAvailable(String project) throws Exception {
    ExecutorService executor = Executors.newSingleThreadExecutor();
    try {
      assertTrue(
          executor
              .submit(
                  () -> {
                    try (LockGuard ignored = bridge.lockForReceivePack(project)) {
                      return true;
                    }
                  })
              .get(2, TimeUnit.SECONDS));
    } finally {
      executor.shutdownNow();
      assertTrue(executor.awaitTermination(10, TimeUnit.SECONDS));
    }
  }

  private static void receive(
      ReceivePack pack, InputStream input, OutputStream output, boolean propagating)
      throws IOException {
    if (propagating)
      pack.receiveWithExceptionPropagation(input, output, new ByteArrayOutputStream());
    else pack.receive(input, output, new ByteArrayOutputStream());
  }

  private void rejectMixedBatch(boolean atomic) throws Exception {
    ReceivePack pack = receivePack(repository);
    Map<String, ObjectId> commands = new LinkedHashMap<>();
    commands.put(REF, winner);
    commands.put("refs/heads/foreign", winner);
    pack.receive(input(commands, atomic), new ByteArrayOutputStream(), new ByteArrayOutputStream());
    assertEquals("atomic=" + atomic, 0, mutations.get());
    assertEquals(2, capturedCommands.get(pack).size());
    assertTrue(
        capturedCommands.get(pack).stream()
            .allMatch(
                command ->
                    command.getResult() != ReceiveCommand.Result.NOT_ATTEMPTED
                        && command.getResult() != ReceiveCommand.Result.OK));
    repository.getRefDatabase().refresh();
    assertEquals(base, repository.exactRef(REF).getObjectId());
    assertNull(repository.exactRef("refs/heads/foreign"));
  }

  private ReceivePack receivePack(Repository into) throws Exception {
    HttpServletRequest request = mock(HttpServletRequest.class);
    when(request.getLocalName()).thenReturn("localhost");
    ReceivePack pack = new WLReceivePackFactory(store, bridge).create(request, into);
    List<ReceiveCommand> received = new ArrayList<>();
    capturedCommands.put(pack, received);
    PreReceiveHook delegate = pack.getPreReceiveHook();
    pack.setPreReceiveHook(
        (receive, commands) -> {
          received.addAll(commands);
          delegate.onPreReceive(receive, commands);
        });
    pack.setBiDirectionalPipe(false);
    pack.setAdvertisedRefs(
        new HashMap<>(Map.of(REF, new ObjectIdRef.Unpeeled(Ref.Storage.LOOSE, REF, base))), null);
    return pack;
  }

  private ByteArrayInputStream input(Map<String, ObjectId> updates, boolean atomic)
      throws Exception {
    ByteArrayOutputStream bytes = new ByteArrayOutputStream();
    PacketLineOut packets = new PacketLineOut(bytes);
    boolean first = true;
    for (Map.Entry<String, ObjectId> update : updates.entrySet()) {
      ObjectId old = update.getKey().equals(REF) ? base : ObjectId.zeroId();
      String capabilities = first ? "\0report-status" + (atomic ? " atomic" : "") : "";
      packets.writeString(
          old.name()
              + " "
              + update.getValue().name()
              + " "
              + update.getKey()
              + capabilities
              + "\n");
      first = false;
    }
    packets.end();
    byte[] emptyPack = ByteBuffer.allocate(12).putInt(0x5041434b).putInt(2).putInt(0).array();
    bytes.write(emptyPack);
    bytes.write(MessageDigest.getInstance("SHA-1").digest(emptyPack));
    return new ByteArrayInputStream(bytes.toByteArray());
  }

  private ObjectId commit(String name, String content) throws Exception {
    Files.writeString(
        repository.getWorkTree().toPath().resolve(name), content, StandardCharsets.UTF_8);
    git.add().addFilepattern(name).call();
    return git.commit()
        .setMessage("synthetic")
        .setAuthor("Synthetic", "test@invalid.example")
        .setCommitter("Synthetic", "test@invalid.example")
        .call()
        .copy();
  }

  private static void await(CountDownLatch latch) {
    try {
      if (!latch.await(10, TimeUnit.SECONDS)) throw new AssertionError("test latch timed out");
    } catch (InterruptedException error) {
      Thread.currentThread().interrupt();
      throw new AssertionError(error);
    }
  }
}
