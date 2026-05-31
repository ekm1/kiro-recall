// Small operator CLI: status / stop / start the background daemon.

import { ensureDaemonRunning, statusReport, stopDaemon } from "./daemon-manager.ts";

async function main(): Promise<void> {
  const cmd = process.argv[2] || "status";
  if (cmd === "status") {
    console.log(await statusReport());
  } else if (cmd === "start") {
    console.log("ensuring daemon:", await ensureDaemonRunning());
    console.log(await statusReport());
  } else if (cmd === "stop") {
    console.log(stopDaemon());
  } else {
    console.log(`unknown command "${cmd}". Use: status | start | stop`);
  }
}

main();
