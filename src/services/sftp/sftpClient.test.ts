import assert from "node:assert/strict";
import test from "node:test";
import { parseInventoryMovementFileDate, resolveInventoryFlowPaths } from "./sftpClient.js";

test("resolveInventoryFlowPaths falls back to the same CONSUMOS source for ENTRADAS", () => {
  const result = resolveInventoryFlowPaths({
    remoteDir: "/SFTP_COA/SFTP_COA/RA",
    localDir: "./data/micros/RA",
    consumosRemoteDir: "/SFTP_COA/SFTP_COA/CONSUMOS",
    consumosLocalDir: "./data/micros/CONSUMOS"
  });

  assert.equal(result.entradasRemoteDir, "/SFTP_COA/SFTP_COA/CONSUMOS");
  assert.equal(result.entradasLocalDir, "./data/micros/CONSUMOS");
});

test("parseInventoryMovementFileDate accepts the same CONSUMOS file naming pattern", () => {
  const parsed = parseInventoryMovementFileDate("CONSUMO_TEST_100825_N.json");

  assert.ok(parsed);
  assert.equal(parsed?.getFullYear(), 2025);
  assert.equal(parsed?.getMonth(), 7);
  assert.equal(parsed?.getDate(), 10);
});
