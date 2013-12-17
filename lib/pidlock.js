// A very gentle version of PID-based locking.
//
// Synopsis.
//
// One has to provide:
//   1) Path to the directory where the app has access to (like '/tmp').
//   2) Unique app key (like 'supercalifragilisticexpialidocious').
//
// Example:
//
//   var pidlock = require('pidlock');
//   pidlock.guard('/tmp', 'supercalifragilisticexpialidocious', function(error, data, cleanup) {
//     if (!error) {
//       // Should run.
//       run();
//       cleanup();
//     } else {
//       // Another instance is already running.
//     }
//   });
//
// Designed to work under pm2 or other form of supervision.
//
// If ends up crashlooping, expects to either get automatically restarted,
// or have a developer / engineer / admin / pager monkey notified.
// Therefore, errs on conservative side.
//
// Based on three assumptions:
// 1) '/proc/' + process.pid + '/cmdline' is accessible iff the process is running.
// 2) Considering processed the same iff '/proc/PID/cmdline' match.
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

module.exports.guard = function(dir, key, callback) {
    assert(_.isString(dir) && dir !== '');
    assert(_.isString(key) && key !== '');
    assert(_.isFunction(callback));

    var outcome = (function() {
        var data = {};

        // createAndInstallExitHook ensures that the logic to remove the lock dir
        // corresponing to this process has been:
        // a) installed on process.on('exit', ...), and
        // b) returned as the cleanup callback.
        // There is no harm invoking this method twice.
        // Adding it to process.on('exit') is an extra security measure in case
        // user code does not invoke cleanup().
        createAndInstallExitHook = function(data) {
            assert(_.isObject(data));
            var me_dir = data.me_dir;
            var lock_dir = data.lock_dir;
            var exitHook = (function() {
                if (_.isString(me_dir) && me_dir !== '') {
                    return function() {
                        if (_.isString(lock_dir) && lock_dir !== '') {
                            var removeLock = false;
                            try {
                                var s = fs.readlinkSync(lock_dir);
                                if (s === me_dir) {
                                    removeLock = true;
                                }
                            } catch (e) {
                            }
                            if (removeLock) {
                                try {
                                    fs.unlinkSync(lock_dir);
                                } catch (e) {
                                    }
                            }
                        }
                        try {
                            fs.rmdirSync(me_dir);
                        } catch (e) {
                            }
                    };  
                } else {
                    return null;
                }   
            })();
            if (exitHook) {
                // No harm in invoking the exit hook twice for extra safety.
                process.on('exit', exitHook);
                return exitHook;
            } else {
                return function() {}; 
            }   
        };  

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
            mkpath.sync(data.me_dir);

            // Try to (atomically) point the lock to an newly created dir
            // by creating a symlink.
            // If symlink creation is successful, assume this is
            // the only running instance of this app.
            try {
                data.state = 'ATTEMPTING_TO_CREATE_A_SYMLINK';
                fs.symlinkSync(data.me_dir, data.lock_dir);
                // All clear, new lock has been created.
                data.state = 'OK';
                return {
                    error: null,
                    data: data,
                    cleanup: createAndInstallExitHook(data),
                };
            } catch (e) {
                // Get the PID of the process that has created the old symlink.
                // Allow the program to fail if this call fails.
                data.state = 'GET_OTHER_CMD';
                // If getting the other PID via readlink fails, something is broken.
                data.other_pid = Number(_.last(fs.readlinkSync(data.lock_dir).split('/')));

                data.other_cmd = '';
                var lock_is_stale = false;
                try {
                    // Getting the command line of the other process, on the other hand,
                    // is something that can fail and should be handler properly.
                    // Proper handling here is the assumption that the lock is stale.
                    data.other_cmd = getCmd(data.other_pid);
                } catch (e) {
                    lock_is_stale = true;
                }

                // The moment of truth.
                // If the lock is not stale and the "other" command line is the same as "mine",
                // then this instance of the app should not start.
                if (!lock_is_stale && data.me_cmd === data.other_cmd) {
                    data.state = 'CONFIRMED_TO_NOT_START';
                    return {
                        error: {},
                        data: data,
                        cleanup: function() {},
                    };
                } else {
                    // Otherwise this instance of the app should take over. Or at least try to.
                    // Before this can happen, the lock has to be acquired properly.
                    // If the lock can not be acquired, there is a higher-order problem
                    // taking place and this app better not start.
                    data.state = 'REMOVING_STALE_LOCK';
                    try {
                        fs.unlinkSync(data.lock_dir);
                    } catch (e) {}

                    // And for extra safety.
                    try {
                        fs.rmdirSync(data.lock_dir);
                    } catch (e) {}


                    data.state = 'CREATING_NEW_SYMLINK';
                    fs.symlinkSync(data.me_dir, data.lock_dir);

                    // All clear, stale lock has been removed, new lock has been created.
                    data.state = 'OK_STALE_LOCK_REMOVED';
                    return {
                        error: null,
                        data: data,
                        cleanup: createAndInstallExitHook(data),
                    };
                }
            }
        } catch (e) {
            // The app should not start if any exception has reached this higher-order try block.
            return {
                error: data,
                data: null,
                cleanup: function() {},
            };
        }
    })();

    assert(_.isObject(outcome));
    callback(outcome.error, outcome.data, outcome.cleanup);
};

// Simple concurrency test.
// Slowly prints one message to stdout.
// Waits for a random amount of time before starting. Keeps trying until can run.
if (require.main === module) {
    process.stdin.resume();
    (function speakUp() {
        setTimeout(function() {
            module.exports.guard('/tmp', 'pidlock_test', function(error, data, cleanup) {
                if (error) {
                    speakUp();
                } else {
                    process.stdout.write((process.env.name || 'Yoda') + ': ');
                    var message = ['May', ' the', ' Force', ' be', ' with', ' you', '.'];

                    function talkNow() {
                        if (message.length > 0) {
                            process.stdout.write(message[0]);
                            message = message.slice(1);
                            setTimeout(talkNow, 100 + Math.random() * 100);
                        } else {
                            process.stdout.write('\n');
                            cleanup();
                            process.exit();
                        }
                    };
                    setTimeout(talkNow, 100 + Math.random() * 100);
                }
            });
        }, Math.random() * 500);
    })();
}
