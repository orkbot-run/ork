// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Ork contributors

import { useMcpForm } from "@orkbot/chat-ui/mcp-form";
import type { ThreadMessage } from "@orkbot/contracts";
import { typeScale } from "@orkbot/ui-tokens";
import { Text, TextInput, View } from "react-native";
import { useI18n } from "../../lib/i18n";
import { useMobileTokens } from "../../lib/native";
import { NativeActionButton } from "../native-action-button";

type Ask = Extract<ThreadMessage["blocks"][number], { kind: "ask" }>;
export function McpFormCard({
  ask,
  canAnswer,
  onAnswer,
}: {
  ask: Ask;
  canAnswer: boolean;
  onAnswer: (answer: string) => Promise<void>;
}) {
  const { t } = useI18n();
  const tokens = useMobileTokens();
  const form = ask.mcpForm!;
  const state = useMcpForm(form, canAnswer && ask.status !== "answered", onAnswer);
  const editable = state.active && !state.pending;
  const secondary = { color: tokens.mutedForeground, ...typeScale.secondary };
  return (
    <View
      testID="mcp-form-card"
      style={{
        width: "100%",
        borderRadius: 18,
        padding: 16,
        gap: 12,
        backgroundColor: tokens.card,
      }}
    >
      <Text style={secondary}>{form.integrationName}</Text>
      <Text style={{ color: tokens.foreground, ...typeScale.cardTitle }}>{ask.text}</Text>
      {state.active ? (
        <>
          {form.fields.map((field) => {
            const label = `${field.title ?? field.name} (${t(field.required ? "Required" : "Optional")})`;
            const value = state.values[field.name];
            const options =
              field.type === "boolean"
                ? [
                    { value: "true", label: t("Yes") },
                    { value: "false", label: t("No") },
                  ]
                : field.options;
            return (
              <View key={field.name} style={{ gap: 4 }}>
                <Text style={{ color: tokens.foreground, ...typeScale.secondary }}>{label}</Text>
                {field.description ? <Text style={secondary}>{field.description}</Text> : null}
                {field.type === "date-time" ? (
                  <Text style={secondary}>
                    {t("Use a date and time with timezone, e.g. 2026-11-20T14:30:00+01:00")}
                  </Text>
                ) : field.type === "date" ? (
                  <Text style={secondary}>YYYY-MM-DD</Text>
                ) : null}
                {options ? (
                  <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
                    {options.map((option) => (
                      <NativeActionButton
                        key={option.value}
                        label={option.label}
                        accessibilityLabel={`${label}: ${option.label}`}
                        prominence="secondary"
                        selected={value !== undefined && String(value) === option.value}
                        disabled={!editable}
                        onPress={() =>
                          state.edit(
                            field.name,
                            field.type === "boolean" ? option.value === "true" : option.value,
                          )
                        }
                      />
                    ))}
                    {!field.required ? (
                      <NativeActionButton
                        label={t("Clear")}
                        prominence="secondary"
                        disabled={!editable}
                        onPress={() => state.edit(field.name, undefined)}
                      />
                    ) : null}
                  </View>
                ) : (
                  <TextInput
                    accessibilityLabel={label}
                    maxLength={field.maxLength ?? 2048}
                    accessibilityHint={field.description}
                    value={String(value ?? "")}
                    editable={editable}
                    autoCapitalize="none"
                    autoCorrect={false}
                    keyboardType={
                      field.type === "number" || field.type === "integer"
                        ? "numbers-and-punctuation"
                        : field.type === "email"
                          ? "email-address"
                          : field.type === "uri"
                            ? "url"
                            : "default"
                    }
                    onChangeText={(next) => state.edit(field.name, next)}
                    style={{
                      borderWidth: 1,
                      borderColor: tokens.border,
                      color: tokens.foreground,
                      borderRadius: 12,
                      padding: 12,
                      minHeight: 48,
                      fontSize: 16,
                    }}
                  />
                )}
              </View>
            );
          })}
          {state.error ? (
            <Text
              accessibilityRole="alert"
              accessibilityLiveRegion="polite"
              style={{ color: tokens.destructive, ...typeScale.secondary }}
            >
              {t(
                state.error === "invalid"
                  ? "Check the required fields and value formats."
                  : "Could not submit this answer",
              )}
            </Text>
          ) : null}
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
            <NativeActionButton
              label={t("Submit")}
              disabled={!editable}
              busy={state.pending}
              onPress={() => void state.submit("accept")}
            />
            <NativeActionButton
              label={t("Decline")}
              prominence="secondary"
              disabled={!editable}
              onPress={() => void state.submit("decline")}
            />
            <NativeActionButton
              label={t("Cancel")}
              prominence="secondary"
              disabled={!editable}
              onPress={() => void state.submit("cancel")}
            />
          </View>
        </>
      ) : (
        <Text accessibilityLiveRegion="polite" style={secondary}>
          {t(
            state.status === "expired"
              ? "Expired"
              : state.status === "accepted"
                ? "Answered"
                : state.status === "declined"
                  ? "Declined"
                  : state.status === "cancelled"
                    ? "Cancelled"
                    : "Pending",
          )}
        </Text>
      )}
    </View>
  );
}
