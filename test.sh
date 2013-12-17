#!/bin/bash
#
# Tests PID-based locking by npm module 'pidlock'.
# Relies on Linux 'ps' behavior, would likely not work on Mac "as is".
# (Although fixing it should not be hard).
#
# Outputs "May the Force be with you." prefixed by four different names.
# The order of names will differ from run to run.
# Modulo sorting, the end result will be the same.

SECRET=supercalifragilisticexpialidocious

if ps axf | grep $SECRET | grep tee >/dev/null 2>/dev/null ; then
    echo "You really don't want to be running two of these tests in parallel. Sorry."
    exit 1
fi


BASE_OUTPUT_DIR=$(mktemp -ud)
OUTPUT_DIR=$BASE_OUTPUT_DIR/$SECRET
mkdir -p $OUTPUT_DIR


echo -e "Working directory: \e[1;34m$BASE_OUTPUT_DIR\e[0m"

(name=Dima node lib/pidlock.js | tee "$OUTPUT_DIR/says-dima" &)
(name=Test node lib/pidlock.js | tee "$OUTPUT_DIR/says-test" &)
(name=Node node lib/pidlock.js | tee "$OUTPUT_DIR/says-node" &)
(name=Jedi node lib/pidlock.js | tee "$OUTPUT_DIR/says-jedi" &)


while ps axf | grep $SECRET | grep tee >/dev/null 2>/dev/null ; do
    sleep 0.5
done


cat >$OUTPUT_DIR/chorus <<EOF
Dima: May the Force be with you.
Jedi: May the Force be with you.
Node: May the Force be with you.
Test: May the Force be with you.
EOF

if ! diff <(cat $OUTPUT_DIR/says-* | sort) $OUTPUT_DIR/chorus ; then
    echo -e '\e[1;31mFAIL\e[0m'
    exit 1
else
    rm -rf $BASE_OUTPUT_DIR
    echo -e '\e[1;32mOK\e[0m'
    exit 0
fi
