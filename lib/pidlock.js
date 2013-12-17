// A very gentle version of PID-based locking.
//
// Synopsis.
// One has to provide:
//   1) A path to the directory to where the app has access to (like '/tmp').
//   2) A unique app key (like 'supercalifragilisticexpialidocious').
//
// Example:
//   var pidlock = require('pidlock');
//   pidlock.guard('/tmp', 'supercalifragilisticexpialidocious', function(error, data) {
//     if (!error) {
//       // Should start.
//     } else {
//       // Should not start.
//     }
//   });
//
// Designed to work under pm2 or other supervisor.
//
// If ends up crashlooping, expects to either get automatically restarted,
// or have a developer / engineer / admin / pager monkey notified.
// Therefore, errs on conservative side.
//
// Based on three assumptions:
// 1) '/proc/' + process.pid + '/cmdline' is accessible iff the process is running.
// 2) Process is considered the same iff '/proc/PID/cmdline' is same for this and other process.
// 3) Directory rename is atomic.
//
// The 1st assumption effectively binds the solution to *nix world.
// For 2nd second assumption it is critical that command-line flags do not change from run to run.
// Therefore, to use in production, pass parameters that may change via external files or ENV.

var _ = require('underscore');
var fs = require('fs');
var path = require('path');
var assert = require('assert');
var mkpath = require('mkpath');

function getCmd(pid) {
    return fs.readFileSync(path.join('/proc', pid.toString(), 'cmdline')).toString();
};

module.exports = function(dir, key, callback) {
    assert(_.isString(dir) && dir !== '');
    assert(_.isString(key) && key !== '');
    assert(_.isFunction(callback));

    var data = {};

    // High-level try block catches exceptions that indicate
    // that either another confirmed instance is already running,
    // or some higher-order issue has been encountered.
    //
    // The application should not start if this block is the one
    // that caught the exception.
    try {
        data.me_cmd = getCmd(process.pid);
        data.me_dir = path.join(dir, key, process.pid.toString());

        data.lock_dir = path.join(dir, key, 'lock');

        // First of all, wipe the directory correspoding to this run.
        // Even if it exists, it is there from the previous run with the same PID
        // and can be safely removed.
        // For this part of the logic, exceptions are caught and ignored.
        data.state = 'WIPING_OLD_RUN_WITH_THIS_PID';
        try {
            fs.rmdirSync(data.me_dir);
        } catch (e) {
            data.wipe_old_pid_exception = e.toString();
        }

        // [Re-]create the directory corresponding to this run.
        // Put the command line of this run into this directory.
        // If something fails along the day, for this moment crashing
        // and having the framework restart the app is the safest solution.
        data.state = 'CREATING_NEW_DATA_FOR_THIS_PID';
        mkpath(data.me_dir);

        // Try to (atomically) point the lock to an newly created dir
        // by creating a symlink.
        // If symlink creation is successful, assume this is
        // the only running instance of this app.
        try {
            data.state = 'ATTEMPTING_TO_CREATE_A_SYMLINK';
            fs.symlinkSync(data.me_dir, data.lock_dir);
            // All clear, new lock has been created.
            data.state = 'OK';
            callback(null, data);
        } catch (e) {
            // Get the PID of the process that has created the old symlink.
            // Allow the program to fail if this call fails.
            data.state = 'GET_OTHER_CMD';
            // If getting the other PID via readlink fails, something is broken.
            data.other_pid = Number(_.last(fs.readlinkSync(data.lock_dir).split('/')));

            data.other_cmd = '';
            try {
                // Getting the command line of the other process, on the other hand,
                // is something that can fail and should be handler properly.
                // Proper handling here is the assumption that the lock is stale.
                data.other_cmd = getCmd(data.other_pid);
            } catch (e) {}

            // The moment of truth.
            // If "other" command line is the same as "mine", this app should not run.
            if (data.me_cmd === data.other_cmd) {
                data.state = 'CONFIRMED_TO_NOT_START';
                callback({}, data);
            } else {
                // Otherwise this instance of the app should take over. Or at least try to.
                // Before this can happen, the lock has to be acquired properly.
                // If the lock can not be acquired, there is a higher-order problem
                // taking place and this app better not start.
                data.state = 'REMOVING_STALE_LOCK';
                try {
                    fs.unlinkSync(data.lock_dir);
                } catch (e) {}

                data.state = 'CREATING_NEW_SYMLINK';
                fs.symlinkSync(data.me_dir, data.lock_dir);

                // All clear, stale lock has been removed, new lock has been created.
                data.state = 'OK_STALE_LOCK_REMOVED';
                callback(null, data);
            }
        }
    } catch (e) {
        // The app should not start if any exception has reached this higher-order try block.
        callback(data, null);
    }
};

// Simple concurrency test.
if (require.main === module) {
    process.stdin.resume();
    (function attempt() {
        setTimeout(function() {
            module.exports('/tmp', 'pidlock_test', function(error, data) {
                if (error) {
                    attempt();
                } else {
                    process.stdout.write((process.env.name || 'Yoda') + ': ');
                    var message = ['May', ' the', ' Force', ' be', ' with', ' you', '.'];

                    function speak() {
                        if (message.length > 0) {
                            process.stdout.write(message[0]);
                            message = message.slice(1);
                            setTimeout(speak, 100 + Math.random() * 100);
                        } else {
                            process.stdout.write('\n');
                            process.exit();
                        }
                    };
                    setTimeout(speak, 100 + Math.random() * 100);
                }
            });
        }, Math.random() * 500);
    })();
}
