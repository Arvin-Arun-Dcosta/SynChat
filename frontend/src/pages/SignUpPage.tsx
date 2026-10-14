import { AtSign, Eye, EyeOff, Loader2, Lock, Mail, User } from "lucide-react";
import { useState, type FormEvent } from "react";
import toast from "react-hot-toast";
import { Link } from "react-router-dom";
import AuthCard from "../components/AuthCard";
import { useAuthStore } from "../store/useAuthStore";

const SignUpPage = () => {
  const [showPassword, setShowPassword] = useState(false);
  const [form, setForm] = useState({ fullName: "", username: "", email: "", password: "" });
  const signup = useAuthStore((s) => s.signup);
  const busy = useAuthStore((s) => s.busy);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const username = form.username.trim().toLowerCase();
    if (!/^[a-z0-9_.]{3,24}$/.test(username)) {
      toast.error("Username must be 3-24 characters: letters, digits, underscore or dot");
      return;
    }
    if (form.password.length < 10) {
      toast.error("Password must be at least 10 characters");
      return;
    }
    void signup({ fullName: form.fullName.trim(), username, email: form.email.trim(), password: form.password });
  };

  return (
    <AuthCard
      title="Create account"
      subtitle="Get started with your free account"
      panelTitle="Join SynChat"
      panelText="Group chats that sort themselves into topics, so you can follow the conversation you care about."
    >
      <form onSubmit={submit} className="space-y-4">
        <label className="block space-y-1">
          <span className="text-sm font-medium">Full name</span>
          <span className="input w-full">
            <User className="size-4 opacity-50" />
            <input name="fullName" autoComplete="name" placeholder="Asha Rao" required maxLength={80} value={form.fullName} onChange={(e) => setForm({ ...form, fullName: e.target.value })} />
          </span>
        </label>
        <label className="block space-y-1">
          <span className="text-sm font-medium">Username</span>
          <span className="input w-full">
            <AtSign className="size-4 opacity-50" />
            <input name="username" autoComplete="username" placeholder="asha" required maxLength={24} value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} />
          </span>
          <span className="text-xs text-base-content/60">This is how friends find you. Only people who know it exactly can.</span>
        </label>
        <label className="block space-y-1">
          <span className="text-sm font-medium">Email</span>
          <span className="input w-full">
            <Mail className="size-4 opacity-50" />
            <input name="email" type="email" autoComplete="email" placeholder="you@example.com" required value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
          </span>
        </label>
        <label className="block space-y-1">
          <span className="text-sm font-medium">Password</span>
          <span className="input w-full">
            <Lock className="size-4 opacity-50" />
            <input
              name="password"
              type={showPassword ? "text" : "password"}
              autoComplete="new-password"
              placeholder="At least 10 characters"
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
          {busy ? <Loader2 className="size-5 animate-spin" /> : "Create account"}
        </button>
      </form>
      <p className="text-center text-base-content/60">
        Already have an account?{" "}
        <Link to="/login" className="link link-primary">
          Sign in
        </Link>
      </p>
    </AuthCard>
  );
};
export default SignUpPage;
