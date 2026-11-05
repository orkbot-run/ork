// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { Button } from "@orkbot/ui-web/components/ui/button";
import { Input } from "@orkbot/ui-web/components/ui/input";
import { Label } from "@orkbot/ui-web/components/ui/label";
import type { FormEvent, ReactNode } from "react";
import { useState } from "react";

type Field = {
  name: string;
  label: string;
  type?: "email" | "password" | "text";
  autoComplete: string;
  minLength?: number;
  maxLength?: number;
};

export const emailField: Field = {
  name: "email",
  label: "Email",
  type: "email",
  autoComplete: "email",
};
export const newPasswordField: Field = {
  name: "password",
  label: "Password (16–128 characters)",
  type: "password",
  autoComplete: "new-password",
  minLength: 16,
  maxLength: 128,
};

export function AccountForm({
  title,
  fields,
  action,
  submit,
  children,
}: {
  title: string;
  fields: Field[];
  action: string;
  submit: (values: Record<string, string>) => Promise<string | null>;
  children?: ReactNode;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(event.currentTarget)) as Record<string, string>;
    setBusy(true);
    setError(null);
    try {
      setError(await submit(values));
    } catch {
      setError("Unable to connect. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <h2 className="text-lg font-medium">{title}</h2>
      {fields.map((field) => (
        <div key={field.name} className="space-y-2">
          <Label htmlFor={field.name}>{field.label}</Label>
          <Input {...field} id={field.name} required disabled={busy} />
        </div>
      ))}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <Button type="submit" className="w-full" disabled={busy}>
        {busy ? "Please wait…" : action}
      </Button>
      {children}
    </form>
  );
}
