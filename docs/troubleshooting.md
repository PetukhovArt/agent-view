# Troubleshooting

## CDP not responding

1. Check the port is listening: `curl -s http://localhost:9876/json/version`
2. For electron-vite: make sure you use `--` before the flag: `npx electron-vite dev -- --remote-debugging-port=9876`
3. Restart the app; HMR doesn't restart the main process

## Stale refs after HMR

After hot reload, refs from previous `dom` calls become invalid. Run `agent-view dom` again to get fresh refs.

## Launch timeout

Complex Electron apps may take >60s on cold start. If `agent-view launch` times out, start the app manually and use `agent-view discover` to verify.
