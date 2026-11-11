export type OpensIn = "outlook" | "outlook_personal" | "gmail" | "mail";

export const OPENS_IN_LABEL: Record<OpensIn, string> = {
  outlook: "Open in Outlook", outlook_personal: "Open in Outlook", gmail: "Open in Gmail", mail: "Open in my mail app",
};

const LONGEST_LINK = 6000;

export function composeLink(kind: OpensIn, to: string[], subject: string, body: string) {
  const many = to.length > 1;
  const list = to.join(kind === "outlook" || kind === "outlook_personal" ? ";" : ",");
  const build = (text: string, addresses: string) => {
    const q = (pairs: [string, string][]) => pairs.filter(([, v]) => v).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&");
    const crlf = text.replace(/\r?\n/g, "\r\n");
    if (kind === "gmail") return `https://mail.google.com/mail/?view=cm&fs=1&${q([[many ? "bcc" : "to", addresses], ["su", subject], ["body", text]])}`;
    if (kind === "mail") {
      const to = many ? "" : encodeURIComponent(addresses).replace(/%40/g, "@");
      return `mailto:${to}?${q([["bcc", many ? addresses : ""], ["subject", subject], ["body", crlf]])}`;
    }
    const host = kind === "outlook_personal" ? "https://outlook.live.com/mail/0" : "https://outlook.office.com/mail";
    return `${host}/deeplink/compose?${q([[many ? "bcc" : "to", addresses], ["subject", subject], ["body", crlf]])}`;
  };
  const full = build(body, list);
  if (full.length <= LONGEST_LINK) return { href: full, carriesText: true };
  const addressed = build("", list);
  return { href: addressed.length <= LONGEST_LINK ? addressed : build("", ""), carriesText: false };
}
