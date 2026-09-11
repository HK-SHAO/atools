import { execFileSync } from "node:child_process";
import { rmSync, statSync } from "node:fs";

const dist = `${import.meta.dirname}/../dist`;
const zip = `${import.meta.dirname}/../toy.zip`;

rmSync(zip, { force: true });
execFileSync("zip", ["-qr", zip, ".", "-x", "*.DS_Store"], { cwd: dist });
console.log(`toy.zip  ${(statSync(zip).size / 1024 / 1024).toFixed(2)} MB  (index.html 在包根)`);
