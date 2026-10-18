"use client";

import { Laptop, Moon, Sun, Vibrate } from "lucide-react";
import { useTheme } from "next-themes";
import { useSyncExternalStore } from "react";
import { Button } from "@clinic/ui/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@clinic/ui/components/ui/dropdown-menu";
import {
  haptic,
  hapticsEnabled,
  hapticsPlausible,
  setHapticsEnabled,
  subscribeHaptics,
} from "@clinic/ui/lib/haptics";

const noSubscribe = () => () => {};

// The theme and vibration menu. It opens as soon as it mounts: theme-toggle.tsx mounts it on the first tap.
export function ThemeMenu() {
  const { theme, setTheme } = useTheme();
  // The vibration switch only appears on touch devices that can vibrate; the server render shows none.
  const canVibrate = useSyncExternalStore(
    noSubscribe,
    hapticsPlausible,
    () => false,
  );
  const vibrateOn = useSyncExternalStore(
    subscribeHaptics,
    hapticsEnabled,
    () => true,
  );
  return (
    <DropdownMenu defaultOpen>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="size-11"
          aria-label="Display settings"
        >
          <Sun className="size-5 dark:hidden" aria-hidden />
          <Moon className="hidden size-5 dark:block" aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-56">
        <DropdownMenuRadioGroup
          value={theme ?? "system"}
          onValueChange={setTheme}
        >
          <DropdownMenuRadioItem className="min-h-11" value="light">
            <Sun className="size-4" aria-hidden /> Light
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem className="min-h-11" value="dark">
            <Moon className="size-4" aria-hidden /> Dark
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem className="min-h-11" value="system">
            <Laptop className="size-4" aria-hidden /> Match my device
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
        {canVibrate ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuCheckboxItem
              className="min-h-11"
              checked={vibrateOn}
              onCheckedChange={(on) => {
                setHapticsEnabled(on);
                if (on) haptic("success");
              }}
            >
              <Vibrate className="size-4" aria-hidden /> Vibrate on actions
            </DropdownMenuCheckboxItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
