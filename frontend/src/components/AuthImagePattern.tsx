import { useState, type MouseEvent } from "react";

const AuthImagePattern = ({ title, subtitle }: { title: string; subtitle: string }) => {
  const [position, setPosition] = useState({ x: 0, y: 0 });

  const handleMouseMove = (e: MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    setPosition({
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
    });
  };

  return (
    <div
      onMouseMove={handleMouseMove}
      className="hidden lg:flex relative items-center justify-center overflow-hidden bg-base-200 p-12"
    >
      <div
        className="absolute inset-0 opacity-60"
        style={{
          background: `
            radial-gradient(circle at 20% 20%, var(--color-primary) 0%, transparent 35%),
            radial-gradient(circle at 80% 30%, var(--color-secondary) 0%, transparent 35%),
            radial-gradient(circle at 40% 80%, var(--color-accent) 0%, transparent 35%)
          `,
        }}
      />

      <div
        className="absolute inset-0 transition-all duration-200 ease-out"
        style={{
          background: `
            radial-gradient(
              400px circle at ${position.x}px ${position.y}px,
              color-mix(in srgb, var(--color-primary) 30%, transparent),
              transparent 60%
            )
          `,
        }}
      />

      <div
        className="absolute inset-0 opacity-[0.08]"
        style={{
          backgroundImage: `
            linear-gradient(to right, var(--color-base-content) 1px, transparent 1px),
            linear-gradient(to bottom, var(--color-base-content) 1px, transparent 1px)
          `,
          backgroundSize: "40px 40px",
        }}
      />

      <div className="absolute inset-0 bg-gradient-to-br from-base-300/30 via-transparent to-base-300/50" />

      <div className="relative z-10 max-w-md text-center">
        <h2 className="text-4xl font-bold mb-5 tracking-tight leading-tight text-base-content">
          {title}
        </h2>
        <p className="text-base-content/70 text-lg leading-relaxed">
          {subtitle}
        </p>
      </div>
    </div>
  );
};

export default AuthImagePattern;