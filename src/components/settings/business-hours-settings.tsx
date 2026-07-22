"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { CalendarClock, Loader2, Plus, X } from "lucide-react";

import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  DEFAULT_SCHEDULE,
  type DayKey,
  type WeeklySchedule,
} from "@/lib/business-hours/schedule";
import { SettingsPanelHead } from "./settings-panel-head";

/**
 * Business hours + out-of-hours auto-reply.
 *
 * Reads and writes `/api/business-hours`, which normalises the payload
 * server-side — so what the operator sees here is exactly what the
 * inbound webhook will evaluate. Non-admins get a read-only view (the
 * `business_hours_update` RLS policy would reject their write anyway).
 */

const DAY_LABEL: Record<DayKey, string> = {
  mon: "Monday",
  tue: "Tuesday",
  wed: "Wednesday",
  thu: "Thursday",
  fri: "Friday",
  sat: "Saturday",
  sun: "Sunday",
};

/** Monday-first for display; DAY_KEYS is Sunday-first to match Date.getDay(). */
const DISPLAY_DAYS: DayKey[] = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

function timeZones(): string[] {
  try {
    // Supported in every runtime this app targets; guarded anyway so a
    // stripped-down browser falls back to a usable short list.
    const all = Intl.supportedValuesOf?.("timeZone");
    if (all?.length) return all;
  } catch {
    /* fall through */
  }
  return ["UTC", "Asia/Kolkata", "Europe/London", "America/New_York"];
}

interface Payload {
  enabled: boolean;
  timezone: string;
  schedule: WeeklySchedule;
  holidays: string[];
  away_message_enabled: boolean;
  away_message: string;
  away_throttle_minutes: number;
  pause_automations: boolean;
  pause_ai_autoreply: boolean;
}

export function BusinessHoursSettings() {
  const { canEditSettings } = useAuth();

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [openNow, setOpenNow] = useState<boolean | null>(null);
  const [nextOpen, setNextOpen] = useState<string | null>(null);

  const [form, setForm] = useState<Payload>({
    enabled: false,
    timezone: "UTC",
    schedule: DEFAULT_SCHEDULE,
    holidays: [],
    away_message_enabled: true,
    away_message: "",
    away_throttle_minutes: 240,
    pause_automations: false,
    pause_ai_autoreply: false,
  });
  const [newHoliday, setNewHoliday] = useState("");

  const zones = useMemo(timeZones, []);
  const disabled = !canEditSettings || saving;

  const applyResponse = useCallback((json: Record<string, unknown>) => {
    const s = json.settings as {
      enabled: boolean;
      timezone: string;
      schedule: WeeklySchedule;
      holidays: string[];
      awayMessageEnabled: boolean;
      awayMessage: string;
      awayThrottleMinutes: number;
      pauseAutomations: boolean;
      pauseAiAutoreply: boolean;
    };
    setForm({
      enabled: s.enabled,
      timezone: s.timezone,
      schedule: s.schedule,
      holidays: s.holidays,
      away_message_enabled: s.awayMessageEnabled,
      away_message: s.awayMessage,
      away_throttle_minutes: s.awayThrottleMinutes,
      pause_automations: s.pauseAutomations,
      pause_ai_autoreply: s.pauseAiAutoreply,
    });
    setOpenNow(json.open_now as boolean);
    setNextOpen((json.next_open as string | null) ?? null);
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/business-hours");
        const json = await res.json();
        if (cancelled) return;
        if (!res.ok) throw new Error(json.error ?? "Failed to load");
        applyResponse(json);
      } catch (err) {
        if (!cancelled) {
          toast.error(
            err instanceof Error ? err.message : "Failed to load business hours",
          );
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [applyResponse]);

  // ---- schedule editing helpers ----------------------------------

  function setDay(day: DayKey, next: Partial<WeeklySchedule[DayKey]>) {
    setForm((f) => ({
      ...f,
      schedule: { ...f.schedule, [day]: { ...f.schedule[day], ...next } },
    }));
  }

  function toggleDay(day: DayKey, open: boolean) {
    // Re-opening a day with no windows left would save as closed, so
    // seed it with a sensible default the operator can then edit.
    const existing = form.schedule[day].windows;
    setDay(day, {
      closed: !open,
      windows:
        open && existing.length === 0
          ? [{ open: "09:00", close: "18:00" }]
          : existing,
    });
  }

  function setWindow(day: DayKey, index: number, field: "open" | "close", value: string) {
    const windows = form.schedule[day].windows.map((w, i) =>
      i === index ? { ...w, [field]: value } : w,
    );
    setDay(day, { windows });
  }

  function addWindow(day: DayKey) {
    setDay(day, {
      closed: false,
      windows: [...form.schedule[day].windows, { open: "14:00", close: "18:00" }],
    });
  }

  function removeWindow(day: DayKey, index: number) {
    const windows = form.schedule[day].windows.filter((_, i) => i !== index);
    setDay(day, { windows, closed: windows.length === 0 });
  }

  function addHoliday() {
    const value = newHoliday.trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      toast.error("Pick a date first");
      return;
    }
    if (form.holidays.includes(value)) {
      toast.error("That date is already a holiday");
      return;
    }
    setForm((f) => ({ ...f, holidays: [...f.holidays, value].sort() }));
    setNewHoliday("");
  }

  async function handleSave() {
    setSaving(true);
    try {
      const res = await fetch("/api/business-hours", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Failed to save");
      applyResponse(json);
      toast.success("Business hours saved");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div>
      <SettingsPanelHead
        title="Business hours"
        description="Tell customers when you're away. Outside these hours wacrm can auto-reply once per conversation, and optionally hold back automations so a bot doesn't answer in your team's voice at 3am."
        action={
          <Button onClick={handleSave} disabled={disabled}>
            {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            Save changes
          </Button>
        }
      />

      <div className="space-y-4">
        {/* ---- master switch + live status ---- */}
        <Card>
          <CardHeader>
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <CardTitle className="flex items-center gap-2">
                  <CalendarClock className="h-4 w-4" />
                  Enable business hours
                  {form.enabled && openNow !== null ? (
                    <Badge variant={openNow ? "default" : "secondary"}>
                      {openNow ? "Open now" : "Closed now"}
                    </Badge>
                  ) : null}
                </CardTitle>
                <CardDescription>
                  {form.enabled
                    ? openNow === false && nextOpen
                      ? `Closed — reopens ${nextOpen}.`
                      : "Your schedule is active."
                    : "Turned off: wacrm treats the account as always open."}
                </CardDescription>
              </div>
              <Switch
                checked={form.enabled}
                onCheckedChange={(v) => setForm((f) => ({ ...f, enabled: v }))}
                disabled={disabled}
              />
            </div>
          </CardHeader>

          <CardContent className="space-y-2">
            <Label htmlFor="bh-timezone">Timezone</Label>
            <Select
              value={form.timezone}
              onValueChange={(v) =>
                setForm((f) => ({ ...f, timezone: v ?? f.timezone }))
              }
              disabled={disabled}
            >
              <SelectTrigger id="bh-timezone">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="max-h-72">
                {zones.map((z) => (
                  <SelectItem key={z} value={z}>
                    {z}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              All times below are wall-clock times in this zone. Daylight
              saving is handled for you.
            </p>
          </CardContent>
        </Card>

        {/* ---- weekly schedule ---- */}
        <Card>
          <CardHeader>
            <CardTitle>Weekly schedule</CardTitle>
            <CardDescription>
              Add a second window for a lunch break. A window that ends
              earlier than it starts (22:00 → 02:00) runs past midnight.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {DISPLAY_DAYS.map((day) => {
              const entry = form.schedule[day];
              return (
                <div
                  key={day}
                  className="rounded-lg border border-border p-3 sm:flex sm:items-start sm:gap-4"
                >
                  <div className="flex w-40 shrink-0 items-center gap-3">
                    <Switch
                      checked={!entry.closed}
                      onCheckedChange={(v) => toggleDay(day, v)}
                      disabled={disabled}
                    />
                    <span className="text-sm font-medium">{DAY_LABEL[day]}</span>
                  </div>

                  <div className="mt-3 min-w-0 flex-1 space-y-2 sm:mt-0">
                    {entry.closed ? (
                      <p className="text-sm text-muted-foreground">Closed</p>
                    ) : (
                      <>
                        {entry.windows.map((w, i) => (
                          <div key={i} className="flex items-center gap-2">
                            <Input
                              type="time"
                              value={w.open}
                              onChange={(e) =>
                                setWindow(day, i, "open", e.target.value)
                              }
                              disabled={disabled}
                              className="w-32"
                              aria-label={`${DAY_LABEL[day]} window ${i + 1} opens`}
                            />
                            <span className="text-muted-foreground">→</span>
                            <Input
                              type="time"
                              value={w.close}
                              onChange={(e) =>
                                setWindow(day, i, "close", e.target.value)
                              }
                              disabled={disabled}
                              className="w-32"
                              aria-label={`${DAY_LABEL[day]} window ${i + 1} closes`}
                            />
                            {entry.windows.length > 1 ? (
                              <Button
                                type="button"
                                variant="ghost"
                                size="icon"
                                onClick={() => removeWindow(day, i)}
                                disabled={disabled}
                                aria-label="Remove window"
                              >
                                <X className="h-4 w-4" />
                              </Button>
                            ) : null}
                          </div>
                        ))}
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() => addWindow(day)}
                          disabled={disabled}
                        >
                          <Plus className="mr-1 h-3.5 w-3.5" />
                          Add window
                        </Button>
                      </>
                    )}
                  </div>
                </div>
              );
            })}
          </CardContent>
        </Card>

        {/* ---- holidays ---- */}
        <Card>
          <CardHeader>
            <CardTitle>Holidays</CardTitle>
            <CardDescription>
              Full-day closures that override the weekly schedule.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex items-center gap-2">
              <Input
                type="date"
                value={newHoliday}
                onChange={(e) => setNewHoliday(e.target.value)}
                disabled={disabled}
                className="w-48"
                aria-label="Holiday date"
              />
              <Button
                type="button"
                variant="secondary"
                onClick={addHoliday}
                disabled={disabled}
              >
                Add
              </Button>
            </div>

            {form.holidays.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No holidays added yet.
              </p>
            ) : (
              <div className="flex flex-wrap gap-2">
                {form.holidays.map((d) => (
                  <Badge key={d} variant="secondary" className="gap-1">
                    {d}
                    <button
                      type="button"
                      onClick={() =>
                        setForm((f) => ({
                          ...f,
                          holidays: f.holidays.filter((x) => x !== d),
                        }))
                      }
                      disabled={disabled}
                      aria-label={`Remove ${d}`}
                      className="ml-1 rounded-sm hover:text-foreground"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </Badge>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {/* ---- away message ---- */}
        <Card>
          <CardHeader>
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <CardTitle>Away message</CardTitle>
                <CardDescription>
                  Sent once per conversation when a customer messages you
                  outside your hours.
                </CardDescription>
              </div>
              <Switch
                checked={form.away_message_enabled}
                onCheckedChange={(v) =>
                  setForm((f) => ({ ...f, away_message_enabled: v }))
                }
                disabled={disabled}
              />
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="bh-away">Message</Label>
              <Textarea
                id="bh-away"
                rows={3}
                maxLength={1024}
                value={form.away_message}
                onChange={(e) =>
                  setForm((f) => ({ ...f, away_message: e.target.value }))
                }
                disabled={disabled || !form.away_message_enabled}
              />
              <p className="text-xs text-muted-foreground">
                Use{" "}
                <code className="rounded bg-muted px-1">{"{{contact_name}}"}</code>{" "}
                and{" "}
                <code className="rounded bg-muted px-1">{"{{next_open}}"}</code>{" "}
                — e.g. &ldquo;tomorrow at 9:00 AM&rdquo;.
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="bh-throttle">Send at most once every</Label>
              <div className="flex items-center gap-2">
                <Input
                  id="bh-throttle"
                  type="number"
                  min={0}
                  max={10080}
                  value={form.away_throttle_minutes}
                  onChange={(e) =>
                    setForm((f) => ({
                      ...f,
                      away_throttle_minutes: Number(e.target.value),
                    }))
                  }
                  disabled={disabled || !form.away_message_enabled}
                  className="w-28"
                />
                <span className="text-sm text-muted-foreground">
                  minutes per conversation
                </span>
              </div>
              <p className="text-xs text-muted-foreground">
                Stops a customer&apos;s five late-night messages from earning
                five identical replies. 0 disables the throttle.
              </p>
            </div>
          </CardContent>
        </Card>

        {/* ---- out-of-hours gates ---- */}
        <Card>
          <CardHeader>
            <CardTitle>While you&apos;re closed</CardTitle>
            <CardDescription>
              Both are off by default — turning on business hours never
              silently disables automation you already rely on.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center justify-between gap-4">
              <div className="min-w-0">
                <Label>Pause automations</Label>
                <p className="text-xs text-muted-foreground">
                  Hold keyword and new-message automations until you reopen.
                </p>
              </div>
              <Switch
                checked={form.pause_automations}
                onCheckedChange={(v) =>
                  setForm((f) => ({ ...f, pause_automations: v }))
                }
                disabled={disabled}
              />
            </div>

            <div className="flex items-center justify-between gap-4">
              <div className="min-w-0">
                <Label>Pause AI auto-reply</Label>
                <p className="text-xs text-muted-foreground">
                  Stop the AI assistant from answering out of hours.
                </p>
              </div>
              <Switch
                checked={form.pause_ai_autoreply}
                onCheckedChange={(v) =>
                  setForm((f) => ({ ...f, pause_ai_autoreply: v }))
                }
                disabled={disabled}
              />
            </div>
          </CardContent>
        </Card>

        {!canEditSettings ? (
          <p className="text-sm text-muted-foreground">
            Only admins and owners can change business hours.
          </p>
        ) : null}
      </div>
    </div>
  );
}
