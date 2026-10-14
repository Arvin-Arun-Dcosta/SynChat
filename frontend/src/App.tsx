import { Loader } from "lucide-react";
import { useEffect } from "react";
import { Toaster } from "react-hot-toast";
import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import Navbar from "./components/Navbar";
import HomePage from "./pages/HomePage";
import InvitePage from "./pages/InvitePage";
import LoginPage from "./pages/LoginPage";
import ProfilePage from "./pages/ProfilePage";
import SettingsPage from "./pages/SettingsPage";
import SignUpPage from "./pages/SignUpPage";
import { AFTER_LOGIN_KEY } from "./lib/share";
import { useAuthStore } from "./store/useAuthStore";
import { useConfigStore } from "./store/useConfigStore";
import { useThemeStore } from "./store/useThemeStore";

const App = () => {
  const user = useAuthStore((s) => s.user);
  const checking = useAuthStore((s) => s.checking);
  const checkAuth = useAuthStore((s) => s.checkAuth);
  const theme = useThemeStore((s) => s.theme);

  const loadConfig = useConfigStore((s) => s.load);
  const location = useLocation();

  useEffect(() => {
    void checkAuth();
    void loadConfig();
  }, [checkAuth, loadConfig]);

  // An invite link opened while signed out: remember it, and return to it after sign-in.
  // (InvitePage clears the note once it is showing.)
  const isInvite = /^\/(u|join)\//.test(location.pathname);
  useEffect(() => {
    if (!user && !checking && isInvite) sessionStorage.setItem(AFTER_LOGIN_KEY, location.pathname);
  }, [user, checking, isInvite, location.pathname]);
  const home = (user && sessionStorage.getItem(AFTER_LOGIN_KEY)) || "/";

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
  }, [theme]);

  if (checking && !user) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader className="size-10 animate-spin" />
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col bg-base-200">
      <Navbar />
      <main className="min-h-0 flex-1">
        <Routes>
          <Route path="/" element={user ? <HomePage /> : <Navigate to="/login" />} />
          <Route path="/signup" element={!user ? <SignUpPage /> : <Navigate to={home} />} />
          <Route path="/login" element={!user ? <LoginPage /> : <Navigate to={home} />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="/profile" element={user ? <ProfilePage /> : <Navigate to="/login" />} />
          <Route path="/u/:code" element={user ? <InvitePage kind="user" /> : <Navigate to="/login" />} />
          <Route path="/join/:code" element={user ? <InvitePage kind="group" /> : <Navigate to="/login" />} />
          <Route path="*" element={<Navigate to="/" />} />
        </Routes>
      </main>
      <Toaster position="top-center" />
    </div>
  );
};
export default App;
