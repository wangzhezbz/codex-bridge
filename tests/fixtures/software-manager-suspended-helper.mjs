import { rename } from "node:fs/promises";

const [mode, source, destination] = process.argv.slice(2);
if (mode === "rename") {
  await rename(source, destination);
} else if (mode === "hang") {
  setInterval(() => {}, 1_000);
} else {
  process.exitCode = 2;
}
