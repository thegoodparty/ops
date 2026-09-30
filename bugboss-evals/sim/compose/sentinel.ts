import { createSocket } from "node:dgram";
import { appendFileSync } from "node:fs";

/**
 * BugBoss's upstream resolver. Docker's embedded DNS answers the stack's own
 * service names and forwards everything else here, so every name BugBoss or
 * an agent tried to leave the sim for lands in this log. The sim network has
 * no route out whatever the answer, so the answer is always NXDOMAIN: this is
 * the record behind the "no reach outside the sim" gate, not the lock.
 */

export interface DnsQuestion {
  id: number;
  name: string;
  type: number;
}

export const parseQuery = (packet: Buffer): DnsQuestion | null => {
  if (packet.length < 12) return null;
  const id = packet.readUInt16BE(0);
  const questions = packet.readUInt16BE(4);
  if (questions < 1) return null;
  const labels: string[] = [];
  let offset = 12;
  for (;;) {
    if (offset >= packet.length) return null;
    const length = packet[offset];
    if (length === 0) {
      offset += 1;
      break;
    }
    // A compression pointer never appears in a question a resolver sends.
    if (length > 63 || offset + 1 + length > packet.length) return null;
    labels.push(packet.subarray(offset + 1, offset + 1 + length).toString("ascii"));
    offset += 1 + length;
  }
  if (offset + 4 > packet.length) return null;
  return { id, name: labels.join(".").toLowerCase(), type: packet.readUInt16BE(offset) };
};

/** The query echoed back with QR set, RA set and RCODE 3 (NXDOMAIN). */
export const nxdomain = (packet: Buffer): Buffer => {
  const question = parseQuery(packet);
  if (!question) return Buffer.alloc(0);
  let end = 12;
  while (packet[end] !== 0) end += 1 + packet[end];
  end += 5;
  const reply = Buffer.from(packet.subarray(0, end));
  const recursionDesired = packet[2] & 0x01;
  reply[2] = 0x80 | recursionDesired;
  reply[3] = 0x80 | 0x03;
  reply.writeUInt16BE(1, 4);
  reply.writeUInt16BE(0, 6);
  reply.writeUInt16BE(0, 8);
  reply.writeUInt16BE(0, 10);
  return reply;
};

export const startSentinel = (options: {
  bind: string;
  port: number;
  record: (entry: { at: number; name: string; type: number; from: string }) => void;
}) => {
  const socket = createSocket("udp4");
  socket.on("message", (packet, from) => {
    const question = parseQuery(packet);
    if (!question) return;
    options.record({
      at: Date.now(),
      name: question.name,
      type: question.type,
      from: from.address,
    });
    socket.send(nxdomain(packet), from.port, from.address);
  });
  return new Promise<typeof socket>((resolve) =>
    socket.bind(options.port, options.bind, () => resolve(socket)),
  );
};

if (require.main === module) {
  const log = process.env.SENTINEL_LOG ?? "/results/egress-dns.jsonl";
  const bind = process.env.SENTINEL_BIND ?? "0.0.0.0";
  void startSentinel({
    bind,
    port: Number(process.env.SENTINEL_PORT ?? 53),
    record: (entry) => appendFileSync(log, `${JSON.stringify(entry)}\n`),
  }).then(() => console.log(JSON.stringify({ event: "sentinel_listening", bind })));
}
