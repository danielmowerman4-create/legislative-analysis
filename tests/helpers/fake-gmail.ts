type Msg = { id: string; threadId: string; labels: string[]; internalDate: number; raw: string; historyId: number };

export class FakeGmail {
  messages: Msg[] = [];
  historyId = 1000;
  // history.list answers 404 for a startHistoryId below this, as Gmail does.
  oldestHistoryId = 0;
  requests: string[] = [];
  read: string[] = [];
  sent: { raw: string; threadId: string | null }[] = [];
  scope = "https://www.googleapis.com/auth/gmail.readonly";
  failNextWith: number | null = null;
  refuseMessages: { status: number; reason?: string; afterGets?: number } | null = null;
  address: string;

  constructor(address: string) {
    this.address = address;
  }

  add(opts: { from: string; fromName?: string; to?: string; subject: string; body: string; date?: Date; labels?: string[]; messageId?: string;
    threadId?: string; inReplyTo?: string; headers?: Record<string, string> }) {
    this.historyId += 7;
    const id = `m${this.messages.length + 1}${Math.random().toString(36).slice(2, 6)}`;
    const date = opts.date ?? new Date();
    const extra = Object.entries(opts.headers ?? {}).map(([k, v]) => `${k}: ${v}\r\n`).join("");
    const raw =
      `Authentication-Results: mx.google.com; dkim=pass header.d=${opts.from.split("@")[1]}; spf=pass smtp.mailfrom=${opts.from}; dmarc=pass header.from=${opts.from.split("@")[1]}\r\n` +
      `From: ${opts.fromName ? `"${opts.fromName}" ` : ""}<${opts.from}>\r\n` +
      `To: <${opts.to ?? this.address}>\r\n` +
      `Subject: ${opts.subject}\r\n` +
      `Date: ${date.toUTCString()}\r\n` +
      `Message-ID: <${opts.messageId ?? `${id}@mail.example`}>\r\n` +
      (opts.inReplyTo ? `In-Reply-To: <${opts.inReplyTo}>\r\n` : "") +
      extra +
      `MIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${opts.body}\r\n`;
    const m: Msg = { id, threadId: opts.threadId ?? `t-${id}`, labels: opts.labels ?? ["INBOX"], internalDate: date.getTime(),
      raw: Buffer.from(raw).toString("base64url"), historyId: this.historyId };
    this.messages.push(m);
    return m;
  }

  expireHistoryBefore(id: number) {
    this.oldestHistoryId = id;
  }

  fetch = async (input: string, init?: RequestInit): Promise<Response> => {
    const url = new URL(input);
    this.requests.push(`${init?.method ?? "GET"} ${url.pathname}`);
    if (this.failNextWith) {
      const status = this.failNextWith;
      this.failNextWith = null;
      return new Response(JSON.stringify({ error: { code: status, status: "RATE_LIMIT" } }), { status, headers: { "retry-after": "1" } });
    }
    const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
    if (url.hostname === "oauth2.googleapis.com") {
      return json({ access_token: "fake-access", refresh_token: "fake-refresh", expires_in: 3600, scope: this.scope });
    }
    const path = url.pathname.replace("/gmail/v1/users/me", "");
    if (path === "/profile") return json({ emailAddress: this.address, historyId: String(this.historyId) });
    if (path === "/labels") return json({ labels: [{ id: "INBOX", name: "INBOX", type: "system" }, { id: "SENT", name: "SENT", type: "system" }] });
    if (path === "/watch") return json({ historyId: String(this.historyId), expiration: String(Date.now() + 7 * 86400_000) });
    if (path === "/messages") {
      const label = url.searchParams.get("labelIds");
      const after = Number((url.searchParams.get("q") ?? "").match(/after:(\d+)/)?.[1] ?? 0) * 1000;
      const list = this.messages
        .filter((m) => (!label || m.labels.includes(label)) && m.internalDate >= after)
        .sort((a, b) => b.internalDate - a.internalDate);
      const page = Number(url.searchParams.get("pageToken") ?? 0);
      const size = Number(url.searchParams.get("maxResults") ?? 100);
      const slice = list.slice(page, page + size);
      return json({ messages: slice.map((m) => ({ id: m.id, threadId: m.threadId })),
        nextPageToken: page + size < list.length ? String(page + size) : undefined });
    }
    if (path === "/messages/send" && init?.method === "POST") {
      if (!this.scope.includes("gmail.send")) return json({ error: { code: 403, status: "PERMISSION_DENIED" } }, 403);
      const body = JSON.parse(String(init.body)) as { raw: string; threadId?: string };
      const raw = Buffer.from(body.raw, "base64url").toString("utf8");
      this.sent.push({ raw, threadId: body.threadId ?? null });
      this.historyId += 7;
      const id = `s${this.messages.length + 1}${Math.random().toString(36).slice(2, 6)}`;
      this.messages.push({ id, threadId: body.threadId ?? `t-${id}`, labels: ["SENT"], internalDate: Date.now(), raw: body.raw, historyId: this.historyId });
      return json({ id, threadId: body.threadId ?? `t-${id}`, labelIds: ["SENT"] });
    }
    const one = path.match(/^\/messages\/([^/]+)$/);
    if (one) {
      const m = this.messages.find((x) => x.id === decodeURIComponent(one[1]));
      if (!m) return json({ error: { code: 404 } }, 404);
      if (url.searchParams.get("format") === "metadata") {
        const wanted = url.searchParams.getAll("metadataHeaders").map((h) => h.toLowerCase());
        const head = Buffer.from(m.raw, "base64url").toString("utf8").split("\r\n\r\n")[0];
        const headers = head.split("\r\n").map((line) => ({ name: line.slice(0, line.indexOf(":")), value: line.slice(line.indexOf(":") + 1).trim() }))
          .filter((h) => wanted.includes(h.name.toLowerCase()));
        return json({ id: m.id, threadId: m.threadId, labelIds: m.labels, internalDate: String(m.internalDate), payload: { headers } });
      }
      if (this.refuseMessages) {
        const r = this.refuseMessages;
        if (!r.afterGets) {
          return json({ error: { code: r.status, status: r.status === 403 ? "PERMISSION_DENIED" : "INTERNAL",
            ...(r.reason ? { errors: [{ domain: "usageLimits", reason: r.reason }] } : {}) } }, r.status);
        }
        r.afterGets--;
      }
      this.read.push(m.id);
      return json({ id: m.id, threadId: m.threadId, labelIds: m.labels, internalDate: String(m.internalDate), raw: m.raw });
    }
    if (path === "/history") {
      const start = Number(url.searchParams.get("startHistoryId"));
      if (start < this.oldestHistoryId) return json({ error: { code: 404, message: "Requested entity was not found." } }, 404);
      const added = this.messages.filter((m) => m.historyId > start);
      return json({ history: added.map((m) => ({ id: String(m.historyId),
        messagesAdded: [{ message: { id: m.id, threadId: m.threadId, labelIds: m.labels } }] })), historyId: String(this.historyId) });
    }
    return json({ error: { code: 404, message: `unhandled ${path}` } }, 404);
  };

  pushBody(deliveryId: string) {
    return { message: { data: Buffer.from(JSON.stringify({ emailAddress: this.address, historyId: this.historyId })).toString("base64"),
      messageId: deliveryId }, subscription: "projects/x/subscriptions/y" };
  }
}
