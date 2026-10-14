import { LogOut, MessageSquare, Settings, User } from "lucide-react";
import { Link } from "react-router-dom";
import { useAuthStore } from "../store/useAuthStore";
import { useChatStore } from "../store/useChatStore";

const Navbar = () => {
  const user = useAuthStore((s) => s.user);
  const logout = useAuthStore((s) => s.logout);
  const connected = useChatStore((s) => s.connected);
  const listLoaded = useChatStore((s) => s.listLoaded);

  return (
    <header className="z-40 shrink-0 border-b border-base-300 bg-base-100">
      <div className="mx-auto flex h-14 max-w-7xl items-center justify-between px-4">
        <Link to="/" className="flex items-center gap-2.5">
          <div className="flex size-9 items-center justify-center rounded-lg bg-primary/10">
            <MessageSquare className="size-5 text-primary" />
          </div>
          <h1 className="text-lg font-bold tracking-tight">SynChat</h1>
        </Link>

        <div className="flex items-center gap-1">
          {user && listLoaded && !connected && (
            <span className="badge badge-warning badge-sm mr-2" role="status">
              Reconnecting…
            </span>
          )}
          <Link to="/settings" className="btn btn-ghost btn-sm gap-2">
            <Settings className="size-4" />
            <span className="hidden sm:inline">Settings</span>
          </Link>
          {user && (
            <>
              <Link to="/profile" className="btn btn-ghost btn-sm gap-2">
                <User className="size-4" />
                <span className="hidden sm:inline">Profile</span>
              </Link>
              <button className="btn btn-ghost btn-sm gap-2" onClick={() => void logout()}>
                <LogOut className="size-4" />
                <span className="hidden sm:inline">Log out</span>
              </button>
            </>
          )}
        </div>
      </div>
    </header>
  );
};
export default Navbar;
