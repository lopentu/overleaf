package uk.ac.ic.wlgitbridge.git.handler;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.attribute.BasicFileAttributes;
import java.util.Collection;
import java.util.HashSet;
import java.util.Set;
import org.eclipse.jgit.lib.ObjectId;
import org.eclipse.jgit.lib.Ref;
import org.eclipse.jgit.lib.Repository;
import org.eclipse.jgit.transport.ReceiveCommand;
import org.eclipse.jgit.transport.ReceivePack;
import uk.ac.ic.wlgitbridge.bridge.Bridge;
import uk.ac.ic.wlgitbridge.bridge.lock.LockGuard;
import uk.ac.ic.wlgitbridge.data.CannotAcquireLockException;
import uk.ac.ic.wlgitbridge.git.handler.hook.WriteLatexPutHook;

/** Share the existing project guard across snapshot mutation and the subsequent JGit ref CAS. */
final class ProjectLockedReceivePack extends ReceivePack {
  private final Bridge bridge;
  private final Path directory;
  private final Object directoryKey;
  private LockGuard guard;

  ProjectLockedReceivePack(Repository repository, Bridge bridge, WriteLatexPutHook hook)
      throws IOException {
    super(repository);
    this.bridge = bridge;
    directory = repository.getDirectory().toPath().toRealPath();
    directoryKey = directoryKey();
    setPreReceiveHook((pack, commands) -> preReceive(hook, commands));
  }

  private Object directoryKey() throws IOException {
    BasicFileAttributes attributes =
        Files.readAttributes(directory, BasicFileAttributes.class, LinkOption.NOFOLLOW_LINKS);
    if (!attributes.isDirectory() || attributes.fileKey() == null) {
      throw new IOException("Git repository identity unavailable");
    }
    return attributes.fileKey();
  }

  private void preReceive(WriteLatexPutHook hook, Collection<ReceiveCommand> commands) {
    if (commands.isEmpty()) return;
    try {
      guard = bridge.lockForReceivePack(getRepository().getWorkTree().getName());
      if (!getRepository().getDirectory().toPath().toRealPath().equals(directory)
          || !directoryKey.equals(directoryKey())) {
        throw new IOException("Git repository changed while receiving push");
      }
      getRepository().getRefDatabase().refresh();
      String branch = getRepository().getFullBranch();
      if (branch == null) throw new IOException("Git default reference unavailable");
      Set<String> names = new HashSet<>();
      boolean invalid = false;
      for (ReceiveCommand command : commands) {
        if (!names.add(command.getRefName())) {
          command.setResult(
              ReceiveCommand.Result.REJECTED_OTHER_REASON, "duplicate reference update");
          invalid = true;
        } else if (command.getRefName().equals(branch)) {
          Ref live = getRepository().exactRef(command.getRefName());
          ObjectId current =
              live == null || live.getObjectId() == null ? ObjectId.zeroId() : live.getObjectId();
          if (!current.equals(command.getOldId())) {
            command.setResult(ReceiveCommand.Result.REJECTED_NONFASTFORWARD);
            invalid = true;
          }
        }
      }
      if (invalid) {
        ReceiveCommand.abort(commands);
        releaseGuard();
        return;
      }
    } catch (CannotAcquireLockException error) {
      reject(commands, error.getMessage());
      return;
    } catch (IOException error) {
      reject(commands, "Git repository changed while receiving push");
      return;
    }
    // The hook validates every default-ref/force policy before capturing either
    // tree. Bridge.push re-enters this same shared guard; execution retains it.
    hook.onPreReceive(this, commands, this::releaseGuard);
    if (commands.stream()
        .noneMatch(command -> command.getResult() == ReceiveCommand.Result.NOT_ATTEMPTED)) {
      releaseGuard();
    }
  }

  private void reject(Collection<ReceiveCommand> commands, String message) {
    for (ReceiveCommand command : commands) {
      if (command.getResult() == ReceiveCommand.Result.NOT_ATTEMPTED) {
        command.setResult(ReceiveCommand.Result.REJECTED_OTHER_REASON, message);
      }
    }
    releaseGuard();
    sendError(message);
  }

  @Override
  protected void executeCommands() {
    try {
      if (guard == null) {
        ReceiveCommand.abort(filterCommands(ReceiveCommand.Result.NOT_ATTEMPTED));
        return;
      }
      super.executeCommands();
    } finally {
      releaseGuard();
    }
  }

  @Override
  public void receive(InputStream input, OutputStream output, OutputStream messages)
      throws IOException {
    try {
      super.receive(input, output, messages);
    } finally {
      releaseGuard();
    }
  }

  @Override
  public void receiveWithExceptionPropagation(
      InputStream input, OutputStream output, OutputStream messages) throws IOException {
    try {
      super.receiveWithExceptionPropagation(input, output, messages);
    } finally {
      releaseGuard();
    }
  }

  private void releaseGuard() {
    LockGuard current = guard;
    guard = null;
    if (current != null) current.close();
  }
}
