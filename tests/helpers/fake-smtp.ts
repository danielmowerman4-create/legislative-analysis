import type { AddressInfo } from "node:net";
import { SMTPServer } from "smtp-server";
import { setSmtpOptionsForTests } from "@/server/email/providers/smtp";

export type Delivered = { from: string; to: string[]; raw: string; user: string };

export async function startFakeSmtp(account: { user?: string; password: string }) {
  const delivered: Delivered[] = [];
  const state = { rejectNext: null as string | null, connections: 0 };
  const server = new SMTPServer({
    authOptional: false,
    allowInsecureAuth: true,
    disabledCommands: ["STARTTLS"],
    logger: false,
    onConnect(_session, cb) {
      state.connections++;
      cb();
    },
    onAuth(auth, _session, cb) {
      if ((!account.user || auth.username === account.user) && auth.password === account.password) return cb(null, { user: auth.username });
      cb(Object.assign(new Error("Username and Password not accepted"), { responseCode: 535 }));
    },
    onData(stream, session, cb) {
      let raw = "";
      stream.on("data", (c: Buffer) => (raw += c.toString("utf8")));
      stream.on("end", () => {
        if (state.rejectNext) {
          const e = Object.assign(new Error(state.rejectNext), { responseCode: 550 });
          state.rejectNext = null;
          return cb(e);
        }
        delivered.push({ from: session.envelope.mailFrom ? session.envelope.mailFrom.address : "", to: session.envelope.rcptTo.map((r) => r.address), raw,
          user: String(session.user) });
        cb();
      });
    },
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.server.address() as AddressInfo).port;
  setSmtpOptionsForTests(() => ({ host: "127.0.0.1", port, secure: false, ignoreTLS: true }));
  return {
    delivered,
    state,
    async close() {
      setSmtpOptionsForTests(null);
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
