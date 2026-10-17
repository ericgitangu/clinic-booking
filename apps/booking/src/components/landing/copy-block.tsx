"use client";

import { Check, Copy } from "lucide-react";
import { useState } from "react";
import { Button } from "@clinic/ui/components/ui/button";
import { notify } from "@clinic/ui/lib/notify";

// A shell snippet with a copy button. The text stays selectable when the clipboard is blocked.
export function CopyBlock({ code, label }: { code: string; label: string }) {
  const [done, setDone] = useState(false);
  return (
    <div className="relative">
      <pre className="overflow-x-auto rounded-lg border border-border bg-muted p-4 pr-14 text-sm leading-6">
        <code>{code}</code>
      </pre>
      <Button
        type="button"
        variant="outline"
        size="icon"
        className="absolute right-2 top-2 size-11"
        aria-label={`Copy: ${label}`}
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(code);
            setDone(true);
            notify.info("Copied.");
            setTimeout(() => setDone(false), 2000);
          } catch {
            notify.warning("Copying was blocked. Select the text instead.");
          }
        }}
      >
        {done ? (
          <Check aria-hidden className="size-4" />
        ) : (
          <Copy aria-hidden className="size-4" />
        )}
      </Button>
    </div>
  );
}
