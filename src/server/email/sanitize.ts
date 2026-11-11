import sanitizeHtml from "sanitize-html";

export function sanitizeEmailHtml(html: string): string {
  return sanitizeHtml(html, {
    allowedTags: [
      "p", "br", "div", "span", "a", "b", "strong", "i", "em", "u", "s", "blockquote", "ul", "ol", "li", "h1", "h2", "h3", "h4", "h5", "h6",
      "table", "thead", "tbody", "tr", "td", "th", "pre", "code", "hr", "img", "font", "center", "small", "sup", "sub",
    ],
    allowedAttributes: {
      a: ["href", "title"],
      img: ["alt", "width", "height", "src"],
      td: ["colspan", "rowspan", "align"],
      th: ["colspan", "rowspan", "align"],
      table: ["width"],
      "*": ["dir", "lang"],
    },
    allowedSchemes: ["http", "https", "mailto", "tel"],
    allowedSchemesByTag: { img: ["cid", "data"] },
    allowProtocolRelative: false,
    disallowedTagsMode: "discard",
    transformTags: {
      a: (tagName, attribs) => ({ tagName, attribs: { ...attribs, target: "_blank", rel: "noopener noreferrer nofollow" } }),
      img: (tagName, attribs) => {
        const src = attribs.src ?? "";
        if (/^(cid|data):/i.test(src)) return { tagName, attribs };
        return { tagName: "span", attribs: {}, text: attribs.alt ? `[image: ${attribs.alt}]` : "[remote image blocked]" };
      },
    },
    exclusiveFilter: (frame) => frame.tag === "img" && !frame.attribs.src,
  });
}
