#!/usr/bin/env bash
# Runs the update-check tests (macOS and the Xcode command line tools). The Python server tests are separate:
#   python -m unittest discover -s tests
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p build
swiftc -parse-as-library -o build/update-tests Sources/Update.swift Tests/UpdateTests.swift
build/update-tests
