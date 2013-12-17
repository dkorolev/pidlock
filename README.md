## pidlock

Simple PID-based solution to ensure at most one instance of a node.js app is running.

### Goal

Make it simple to guard an app from multiple parallel invocations.

### Synopsis

```
var pidlock = require('pidlock');
pidlock.guard('/tmp', 'supercalifragilisticexpialidocious', function(error, data, cleanup) {
  if (!error) {
    // Should run.
    run();
    cleanup();
  } else {
    // Another instance is already running.
  }
});
```

### Design

```pidlock``` is based on creating the directory with the name corresponding to the PID of the process and then [atomically] renaming this directory to become or replace the "lock file".

The "lock file" is technically a symlink to another directory with the name being the PID of the process that used to acquire this ```pidlock``` before.

The authencity of the lock is validated by two checks:

1. ```/proc/$old_pid/cmdline``` for the older PID can be read. This also confirms the process is alive.
2. ```/prod/$current_pid/cmdline``` for the process trying to acquire the lock matches the one for the process that has done it before.

**Important: The command line must be the same in order for this logic to work. Make sure your system invokes the code with the same command line.**

Dynamic parameters will have to be passed via flags or ```process.env``` to avoid this issue.

If you do not do so, different invocations of the same script with different command lines would be considered different apps and they will fight for the lock.

If all the checks pass, the process is not being spawned.

### Guarantees

None.

In case of uncertainty, ```pidlock``` errs on the conversative side, assuming that if the server runs under some supervisor and that someone would eventually get notified should it start crashlooking. Although crashlooping could primarily occur if some file/path permissions are off, which would be easy to see right away.

If the checks fail in a way that allows drawing the conclusion that the lock is stale, it is being overwritten and the new process is being started.
