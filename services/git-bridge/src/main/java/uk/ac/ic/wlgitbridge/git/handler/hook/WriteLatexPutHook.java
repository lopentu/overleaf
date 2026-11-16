package uk.ac.ic.wlgitbridge.git.handler.hook;

import com.google.api.client.auth.oauth2.Credential;
import java.io.IOException;
import java.util.Collection;
import java.util.Iterator;
import java.util.Optional;
import org.eclipse.jgit.lib.Repository;
import org.eclipse.jgit.transport.PreReceiveHook;
import org.eclipse.jgit.transport.ReceiveCommand;
import org.eclipse.jgit.transport.ReceiveCommand.Result;
import org.eclipse.jgit.transport.ReceivePack;
import uk.ac.ic.wlgitbridge.bridge.Bridge;
import uk.ac.ic.wlgitbridge.bridge.repo.RepoStore;
import uk.ac.ic.wlgitbridge.data.CannotAcquireLockException;
import uk.ac.ic.wlgitbridge.data.filestore.RawDirectory;
import uk.ac.ic.wlgitbridge.git.exception.GitUserException;
import uk.ac.ic.wlgitbridge.git.handler.hook.exception.ForcedPushException;
import uk.ac.ic.wlgitbridge.git.handler.hook.exception.WrongBranchException;
import uk.ac.ic.wlgitbridge.snapshot.push.exception.InternalErrorException;
import uk.ac.ic.wlgitbridge.snapshot.push.exception.OutOfDateException;
import uk.ac.ic.wlgitbridge.util.Log;

/*
 * Created by Winston on 03/11/14.
 */
/*
 * Created by {@link WLReceivePackFactory} to update the {@link Bridge} for a
 * user's Git push request, or fail with an error. The hook is able to approve
 * or reject a request.
 */
public class WriteLatexPutHook implements PreReceiveHook {

  private final RepoStore repoStore;

  private final Bridge bridge;
  private final String hostname;
  private final Optional<Credential> oauth2;

  /*
   * The constructor to use, which provides the hook with the {@link Bridge},
   * the hostname (used to construct a URL to give to Overleaf to postback),
   * and the oauth2 (used to authenticate with the Snapshot API).
   * @param repoStore
   * @param bridge the {@link Bridge}
   * @param hostname the hostname used for postback from the Snapshot API
   * @param oauth2 used to authenticate with the snapshot API, or null
   */
  public WriteLatexPutHook(
      RepoStore repoStore, Bridge bridge, String hostname, Optional<Credential> oauth2) {
    this.repoStore = repoStore;
    this.bridge = bridge;
    this.hostname = hostname;
    this.oauth2 = oauth2;
  }

  @Override
  public void onPreReceive(ReceivePack receivePack, Collection<ReceiveCommand> receiveCommands) {
    onPreReceive(receivePack, receiveCommands, () -> {});
  }

  /** Release receive-scoped state after rejection and before potentially blocking client output. */
  public void onPreReceive(
      ReceivePack receivePack,
      Collection<ReceiveCommand> receiveCommands,
      Runnable beforeRejectionOutput) {
    // Validate the complete batch before the first snapshot side effect.
    for (ReceiveCommand command : receiveCommands) {
      try {
        checkBranch(command, receivePack.getRepository());
        checkForcedPush(command);
      } catch (WrongBranchException | ForcedPushException error) {
        Log.warn("User push rejected on pre receive: {}", error.getMessage());
        handleSnapshotPostException(
            receivePack, receiveCommands, command, error, beforeRejectionOutput);
        return;
      } catch (IOException error) {
        rejectCommands(
            receiveCommands,
            command,
            Result.REJECTED_OTHER_REASON,
            error.getMessage(),
            beforeRejectionOutput);
        receivePack.sendError(error.getMessage());
        return;
      } catch (Throwable error) {
        Log.error("Unable to validate receive commands", error);
        handleSnapshotPostException(
            receivePack,
            receiveCommands,
            command,
            new InternalErrorException(),
            beforeRejectionOutput);
        return;
      }
    }
    Log.debug(
        "-> Handling {} commands in {}",
        receiveCommands.size(),
        receivePack.getRepository().getDirectory().getAbsolutePath());
    for (ReceiveCommand receiveCommand : receiveCommands) {
      try {
        handleReceiveCommand(oauth2, receivePack.getRepository(), receiveCommand);
      } catch (IOException e) {
        Log.error("IOException on pre receive", e);
        rejectCommands(
            receiveCommands,
            receiveCommand,
            Result.REJECTED_OTHER_REASON,
            e.getMessage(),
            beforeRejectionOutput);
        receivePack.sendError(e.getMessage());
        return;
      } catch (OutOfDateException e) {
        Log.error("OutOfDateException on pre receive", e);
        rejectCommands(
            receiveCommands,
            receiveCommand,
            Result.REJECTED_NONFASTFORWARD,
            null,
            beforeRejectionOutput);
        return;
      } catch (WrongBranchException | ForcedPushException e) {
        Log.warn("User push rejected on pre receive: {}", e.getMessage());
        handleSnapshotPostException(
            receivePack, receiveCommands, receiveCommand, e, beforeRejectionOutput);
        return;
      } catch (GitUserException e) {
        Log.error("GitUserException on pre receive", e);
        handleSnapshotPostException(
            receivePack, receiveCommands, receiveCommand, e, beforeRejectionOutput);
        return;
      } catch (CannotAcquireLockException e) {
        Log.info("CannotAcquireLockException on pre receive");
        rejectCommands(
            receiveCommands,
            receiveCommand,
            Result.REJECTED_OTHER_REASON,
            e.getMessage(),
            beforeRejectionOutput);
        receivePack.sendError(e.getMessage());
        return;
      } catch (Throwable t) {
        Log.error("Throwable on pre receive", t);
        handleSnapshotPostException(
            receivePack,
            receiveCommands,
            receiveCommand,
            new InternalErrorException(),
            beforeRejectionOutput);
        return;
      }
    }
    Log.debug(
        "-> Handled {} commands in {}",
        receiveCommands.size(),
        receivePack.getRepository().getDirectory().getAbsolutePath());
  }

  private void rejectCommands(
      Collection<ReceiveCommand> commands,
      ReceiveCommand command,
      Result result,
      String message,
      Runnable beforeRejectionOutput) {
    command.setResult(result, message);
    ReceiveCommand.abort(commands);
    beforeRejectionOutput.run();
  }

  private void handleSnapshotPostException(
      ReceivePack receivePack,
      Collection<ReceiveCommand> commands,
      ReceiveCommand receiveCommand,
      GitUserException e,
      Runnable beforeRejectionOutput) {
    String message = e.getMessage();
    rejectCommands(
        commands, receiveCommand, Result.REJECTED_OTHER_REASON, message, beforeRejectionOutput);
    receivePack.sendError(message);
    StringBuilder msg = new StringBuilder();
    for (Iterator<String> it = e.getDescriptionLines().iterator(); it.hasNext(); ) {
      String line = it.next();
      msg.append("hint: ");
      msg.append(line);
      if (it.hasNext()) {
        msg.append('\n');
      }
    }
    receivePack.sendMessage("");
    receivePack.sendMessage(msg.toString());
  }

  private void handleReceiveCommand(
      Optional<Credential> oauth2, Repository repository, ReceiveCommand receiveCommand)
      throws IOException, GitUserException, CannotAcquireLockException {
    checkBranch(receiveCommand, repository);
    checkForcedPush(receiveCommand);
    bridge.push(
        oauth2,
        repository.getWorkTree().getName(),
        getPushedDirectoryContents(repository, receiveCommand),
        getOldDirectoryContents(repository),
        hostname);
  }

  private void checkBranch(ReceiveCommand receiveCommand, Repository repository)
      throws WrongBranchException, IOException {
    String expectedRef = repository.getFullBranch();
    if (expectedRef == null) {
      throw new IllegalStateException(
          "Cannot determine expected branch: repository HEAD is unresolved"
              + " (detached or unborn ref)");
    }
    if (!receiveCommand.getRefName().equals(expectedRef)) {
      throw new WrongBranchException(expectedRef);
    }
  }

  private void checkForcedPush(ReceiveCommand receiveCommand) throws ForcedPushException {
    if (receiveCommand.getType() == ReceiveCommand.Type.UPDATE_NONFASTFORWARD) {
      throw new ForcedPushException();
    }
  }

  private RawDirectory getPushedDirectoryContents(
      Repository repository, ReceiveCommand receiveCommand) throws IOException, GitUserException {
    return repoStore.useJGitRepo(repository, receiveCommand.getNewId()).getDirectory();
  }

  private RawDirectory getOldDirectoryContents(Repository repository)
      throws IOException, GitUserException {
    return repoStore.useJGitRepo(repository, repository.resolve("HEAD")).getDirectory();
  }
}
