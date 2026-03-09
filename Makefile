SHELL := /usr/bin/env bash

GOOS_NATIVE := $(shell go env GOOS)
GOARCH_NATIVE := $(shell go env GOARCH)
APP_VERSION ?= $(shell (git describe --tags --always --dirty 2>/dev/null) || echo v0.0.0)

.PHONY: dev dev-stop web-install web-build server-build reset-admin build build-linux build-windows release run fmt test clean

dev:
	./scripts/dev.sh

dev-stop:
	./scripts/dev-stop.sh

web-install:
	npm --prefix web install

web-build:
	VITE_APP_VERSION=$(APP_VERSION) npm --prefix web run build

server-build:
	mkdir -p bin
	cd server && go build -o ../bin/all-monitor ./cmd/app

reset-admin:
	cd server && go run ./cmd/app reset-admin

build: web-build server-build

build-linux: web-build
	mkdir -p bin
	cd server && GOOS=linux GOARCH=amd64 CGO_ENABLED=1 go build -o ../bin/all-monitor-linux-amd64 ./cmd/app

build-windows: web-build
	mkdir -p bin
	cd server && GOOS=windows GOARCH=amd64 CGO_ENABLED=1 CC=x86_64-w64-mingw32-gcc go build -o ../bin/all-monitor-windows-amd64.exe ./cmd/app

release:
	./scripts/release.sh

run: build
	./bin/all-monitor

fmt:
	cd server && gofmt -w ./cmd ./internal ./pkg

test:
	cd server && go build ./...
	npm --prefix web run build

clean:
	rm -rf bin
