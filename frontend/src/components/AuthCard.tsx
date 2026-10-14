import { MessageSquare } from "lucide-react";
import type { ReactNode } from "react";
import AuthImagePattern from "./AuthImagePattern";

interface Props {
  title: string;
  subtitle: string;
  panelTitle: string;
  panelText: string;
  children: ReactNode;
}

/** Shared frame for the sign-in and sign-up pages. */
const AuthCard = ({ title, subtitle, panelTitle, panelText, children }: Props) => (
  <div className="grid h-full overflow-y-auto bg-base-200 lg:grid-cols-2">
    <div className="flex flex-col items-center justify-center p-6 sm:p-12">
      <div className="w-full max-w-md space-y-6 rounded-2xl border border-base-300 bg-base-100 p-8 shadow-xl">
        <div className="flex flex-col items-center gap-2 text-center">
          <div className="flex size-12 items-center justify-center rounded-xl bg-primary/10">
            <MessageSquare className="size-6 text-primary" />
          </div>
          <h1 className="mt-2 text-2xl font-bold tracking-tight">{title}</h1>
          <p className="text-base-content/60">{subtitle}</p>
        </div>
        {children}
      </div>
    </div>
    <AuthImagePattern title={panelTitle} subtitle={panelText} />
  </div>
);
export default AuthCard;
