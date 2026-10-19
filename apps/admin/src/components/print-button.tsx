"use client";

import { PrinterIcon } from "lucide-react";
import { Button } from "@clinic/ui/components/ui/button";

export function PrintButton() {
  return (
    <Button className="no-print min-h-11" onClick={() => window.print()}>
      <PrinterIcon aria-hidden /> Print
    </Button>
  );
}
