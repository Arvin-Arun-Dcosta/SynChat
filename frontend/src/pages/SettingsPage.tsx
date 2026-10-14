import { useEffect, useState, type ReactNode } from "react";
import toast from "react-hot-toast";
import { disablePush, enablePush, pushEnabled, pushSupported } from "../lib/push";
import { THEMES } from "../constants";
import { useAuthStore } from "../store/useAuthStore";
import { useConfigStore } from "../store/useConfigStore";
import { setSmart, useSmart } from "../store/useSmartStore";
import { useThemeStore } from "../store/useThemeStore";
import type { SmartFeature } from "../types";

interface FeatureInfo {
  feature: SmartFeature;
  title: string;
  description: string;
  /** Needs an outside AI provider: only offered when the server has one configured. */
  usesAi?: boolean;
}

const FEATURES: FeatureInfo[] = [
  { feature: "lanes", title: "Topic lanes", description: "Show which topic each group message belongs to, and a Topics view of every lane. Lanes are worked out on SynChat's own server." },
  { feature: "topicMute", title: "Topic mute", description: "Mute one topic instead of a whole group. Muted topics do not notify you or add to unread counts, unless someone mentions you." },
  { feature: "search", title: "Meaning search", description: "Search all your chats by what a message was about, not only its exact words." },
  { feature: "catchUp", title: "Catch-up", description: "A two-line summary of what you missed in a topic with unread messages.", usesAi: true },
  { feature: "status", title: "Decided or still open", description: "Show whether a topic has been settled, with the outcome pinned at the top.", usesAi: true },
  { feature: "inbox", title: "Questions waiting on you", description: "One list, across all chats, of questions people asked you that you have not answered.", usesAi: true },
];

const Switch = ({ info }: { info: FeatureInfo }) => {
  const on = useSmart(info.feature);
  return (
    <label className="flex cursor-pointer items-start gap-4 py-3">
      <div className="min-w-0 flex-1">
        <div className="font-medium">{info.title}</div>
        <p className="text-sm text-base-content/70">{info.description}</p>
      </div>
      <input
        type="checkbox"
        className="toggle toggle-primary mt-1"
        role="switch"
        aria-label={info.title}
        checked={on}
        onChange={(e) => void setSmart(info.feature, e.target.checked)}
      />
    </label>
  );
};

const Section = ({ title, hint, children }: { title: string; hint: string; children: ReactNode }) => (
  <section className="space-y-3">
    <div>
      <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
      <p className="text-sm text-base-content/70">{hint}</p>
    </div>
    {children}
  </section>
);

/** Chrome's "this site can be installed" event, kept so Settings can offer an Install button. */
interface InstallPrompt extends Event {
  prompt: () => Promise<void>;
}
let installPrompt: InstallPrompt | null = null;
window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  installPrompt = e as InstallPrompt;
});

const Notifications = () => {
  const available = useConfigStore((s) => s.features.push) && pushSupported();
  const muteOn = useSmart("topicMute");
  const [on, setOn] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void pushEnabled().then(setOn);
  }, []);

  const toggle = async (next: boolean) => {
    setBusy(true);
    try {
      await (next ? enablePush() : disablePush());
      setOn(next);
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section title="This device" hint="Notifications and installing SynChat as an app.">
      <div className="divide-y divide-base-300 rounded-xl border border-base-300 bg-base-100 px-4">
        <label className={`flex items-start gap-4 py-3 ${available ? "cursor-pointer" : "opacity-60"}`}>
          <div className="min-w-0 flex-1">
            <div className="font-medium">Notifications on this device</div>
            <p className="text-sm text-base-content/70">
              {available
                ? `Get notified of new messages when SynChat is not in front of you.${muteOn ? " Topics you have muted stay quiet unless someone mentions you." : ""}`
                : "Not available: this server has no push keys configured, or this browser does not support web push."}
            </p>
          </div>
          <input type="checkbox" role="switch" className="toggle toggle-primary mt-1" aria-label="Notifications on this device" checked={on} disabled={!available || busy} onChange={(e) => void toggle(e.target.checked)} />
        </label>
        <div className="flex items-start gap-4 py-3">
          <div className="min-w-0 flex-1">
            <div className="font-medium">Install SynChat</div>
            <p className="text-sm text-base-content/70">Add it to your home screen or desktop. If the button does nothing, use your browser&apos;s &ldquo;Install&rdquo; or &ldquo;Add to Home Screen&rdquo; menu.</p>
          </div>
          <button className="btn btn-sm mt-1" onClick={() => void installPrompt?.prompt()}>
            Install
          </button>
        </div>
      </div>
    </Section>
  );
};

const SettingsPage = () => {
  const user = useAuthStore((s) => s.user);
  const theme = useThemeStore((s) => s.theme);
  const setTheme = useThemeStore((s) => s.setTheme);
  const llm = useConfigStore((s) => s.features.llm);
  const offered = FEATURES.filter((f) => !f.usesAi || llm);

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-3xl space-y-10 px-4 py-8">
        {user && (
          <Section title="Smart features" hint="Each of these can be switched off. With all of them off, SynChat is a plain messenger.">
            <div className="divide-y divide-base-300 rounded-xl border border-base-300 bg-base-100 px-4" data-testid="smart-features">
              {offered.map((info) => (
                <Switch key={info.feature} info={info} />
              ))}
            </div>
            {llm && (
              <p className="text-xs text-base-content/60">
                The last three use an outside AI provider. They only work in groups whose admin has switched them on, because they send that group&apos;s messages to the provider. In
                those groups the provider also re-sorts messages into topics a little after they arrive; everywhere else, sorting stays on our server.
              </p>
            )}
          </Section>
        )}

        {user && <Notifications />}

        <Section title="Theme" hint="Choose how SynChat looks on this device.">
          <div className="grid grid-cols-4 gap-2 sm:grid-cols-6 md:grid-cols-8">
            {THEMES.map((t) => (
              <button
                key={t}
                aria-pressed={theme === t}
                className={`flex flex-col items-center gap-1.5 rounded-lg border border-base-300 p-2 transition-colors ${theme === t ? "bg-base-100 ring-2 ring-primary" : "hover:bg-base-100"}`}
                onClick={() => setTheme(t)}
              >
                <div className="relative h-8 w-full overflow-hidden rounded-md" data-theme={t}>
                  <div className="absolute inset-0 grid grid-cols-4 gap-px p-1">
                    <div className="rounded bg-primary" />
                    <div className="rounded bg-secondary" />
                    <div className="rounded bg-accent" />
                    <div className="rounded bg-neutral" />
                  </div>
                </div>
                <span className="w-full truncate text-center text-[11px] font-medium">{t.charAt(0).toUpperCase() + t.slice(1)}</span>
              </button>
            ))}
          </div>
        </Section>
      </div>
    </div>
  );
};
export default SettingsPage;
