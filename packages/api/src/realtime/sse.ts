// A small Server-Sent Events parser: bytes in, frames out. Comment lines (": ...") are heartbeats.
export type SseFrame =
  | { kind: "event"; event: string; data: string; id: string | null }
  | { kind: "comment"; text: string };

export function createSseParser(onFrame: (f: SseFrame) => void) {
  const decoder = new TextDecoder();
  let buffer = "";
  let event = "message";
  let data: string[] = [];
  let id: string | null = null;

  const line = (l: string) => {
    if (l === "") {
      if (data.length > 0)
        onFrame({ kind: "event", event, data: data.join("\n"), id });
      event = "message";
      data = [];
      id = null;
    } else if (l.startsWith(":")) {
      onFrame({ kind: "comment", text: l.slice(1).trim() });
    } else {
      const i = l.indexOf(":");
      const field = i === -1 ? l : l.slice(0, i);
      let value = i === -1 ? "" : l.slice(i + 1);
      if (value.startsWith(" ")) value = value.slice(1);
      if (field === "event") event = value;
      else if (field === "data") data.push(value);
      else if (field === "id") id = value;
    }
  };

  return {
    push(chunk: Uint8Array) {
      buffer += decoder.decode(chunk, { stream: true });
      let m: RegExpExecArray | null;
      while ((m = /\r\n|\n|\r/.exec(buffer))) {
        const l = buffer.slice(0, m.index);
        buffer = buffer.slice(m.index + m[0].length);
        line(l);
      }
    },
  };
}
