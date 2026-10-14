import { MessageSquare } from "lucide-react";

const NoChatSelected = () => (
  <div className="hidden flex-1 flex-col items-center justify-center p-16 md:flex">
    <div className="max-w-md space-y-4 text-center">
      <div className="mx-auto flex size-16 items-center justify-center rounded-2xl bg-primary/10">
        <MessageSquare className="size-8 text-primary" />
      </div>
      <h2 className="text-2xl font-bold tracking-tight">Welcome to SynChat</h2>
      <p className="text-base-content/60">Pick a chat on the left, or start a new one.</p>
    </div>
  </div>
);
export default NoChatSelected;
