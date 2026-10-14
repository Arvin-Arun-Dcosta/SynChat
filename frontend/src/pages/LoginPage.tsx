import { Eye, EyeOff, Loader2, Lock, User } from "lucide-react";
import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import AuthCard from "../components/AuthCard";
import { useAuthStore } from "../store/useAuthStore";

const LoginPage = () => {
  const [showPassword, setShowPassword] = useState(false);
  const [form, setForm] = useState({ identifier: "", password: "" });
  const login = useAuthStore((s) => s.login);
  const busy = useAuthStore((s) => s.busy);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void login({ identifier: form.identifier.trim(), password: form.password });
  };

  return (
    <AuthCard
      title="Welcome back"
      subtitle="Sign in to your account"
      panelTitle="Welcome back!"
      panelText="Sign in to continue your conversations and catch up with your messages."
    >
      <form onSubmit={submit} className="space-y-4">
        <label className="block space-y-1">
          <span className="text-sm font-medium">Email or username</span>
          <span className="input w-full">
            <User className="size-4 opacity-50" />
            <input
              name="identifier"
              autoComplete="username"
              placeholder="you@example.com"
              required
              value={form.identifier}
              onChange={(e) => setForm({ ...form, identifier: e.target.value })}
            />
          </span>
        </label>
        <label className="block space-y-1">
          <span className="text-sm font-medium">Password</span>
          <span className="input w-full">
            <Lock className="size-4 opacity-50" />
            <input
              name="password"
              type={showPassword ? "text" : "password"}
              autoComplete="current-password"
              placeholder="••••••••••"
              required
              value={form.password}
              onChange={(e) => setForm({ ...form, password: e.target.value })}
            />
            <button type="button" aria-label={showPassword ? "Hide password" : "Show password"} onClick={() => setShowPassword(!showPassword)}>
              {showPassword ? <EyeOff className="size-4 opacity-50" /> : <Eye className="size-4 opacity-50" />}
            </button>
          </span>
        </label>
        <button type="submit" className="btn btn-primary w-full" disabled={busy}>
          {busy ? <Loader2 className="size-5 animate-spin" /> : "Sign in"}
        </button>
      </form>
      <p className="text-center text-base-content/60">
        Don&apos;t have an account?{" "}
        <Link to="/signup" className="link link-primary">
          Create account
        </Link>
      </p>
    </AuthCard>
  );
};
export default LoginPage;
