// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Ork contributors (modifications)
// Inherited Apache material is preserved; catalog selection and scoped rule editing are Ork changes.

import { MenuView } from "@expo/ui/community/menu";
import type { ActionApprovalRule, ActionAutoReviewSettings } from "@orkbot/contracts";
import {
  APPROVAL_RULE_TOOLS,
  approvalRuleEffects,
  approvalRuleTool,
  hasSeparateComputerApproval,
  humanizeToolName,
  initialApprovalRuleEffect,
  listSearch,
  toolNameFromLabel,
} from "@orkbot/core";
import { useFocusEffect, useLocalSearchParams, useNavigation, useRouter } from "expo-router";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Platform, ScrollView, StyleSheet, Text } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { ListSearchInput } from "../../components/list-search-input";
import { LoadFailure } from "../../components/load-failure";
import { MenuPicker } from "../../components/menu-picker";
import { NativeActionButton } from "../../components/native-action-button";
import { Checkmark } from "../../components/row-accessories";
import {
  SettingsFooter,
  SettingsGroup,
  SettingsInputRow,
  SettingsRow,
} from "../../components/settings-group";
import { mobileTokens } from "../../lib/appearance";
import { useI18n } from "../../lib/i18n";
import { native, useResolvedAppearance, useThemedStyles } from "../../lib/native";
import { iosAtLeast } from "../../lib/native-controls";
import type { SettingsTarget } from "../../lib/settings-target";
import { settingsRpc, settingsTarget } from "../../lib/settings-target";
import { useSideInsets } from "../../lib/side-insets";
import { errorText } from "../../lib/user-error";

type RuleAction = ActionApprovalRule["effect"] | "remove";
const OTHER_TOOL = "__other__";

/** Route ownership changes remount the editor, so late results cannot close another Space's form. */
export default function ApprovalRules() {
  const { spaceId, tool } = useLocalSearchParams<{ spaceId?: string; tool?: string }>();
  const target = useMemo(() => settingsTarget(spaceId), [spaceId]);
  const key = target.scope === "space" ? target.spaceId : "account";
  return (
    <ApprovalRulesEditor
      key={key}
      target={target}
      toolParam={typeof tool === "string" ? tool : undefined}
    />
  );
}

function ApprovalRulesEditor({
  target,
  toolParam,
}: {
  target: SettingsTarget;
  toolParam?: string;
}) {
  const rpc = useMemo(() => settingsRpc(target), [target]);
  const scope = target.scope;
  const { t } = useI18n();
  const navigation = useNavigation();
  const router = useRouter();
  const colorScheme = useResolvedAppearance();
  const sideInsets = useSideInsets();
  const styles = useThemedStyles(createStyles);
  const [rules, setRules] = useState<ActionApprovalRule[] | null>(null);
  const [settings, setSettings] = useState<ActionAutoReviewSettings | null>(null);
  const [adding, setAdding] = useState(Boolean(approvalRuleTool(toolParam ?? "")));
  const [tool, setTool] = useState<string>(approvalRuleTool(toolParam ?? "")?.name ?? "");
  const [otherTool, setOtherTool] = useState("");
  const [query, setQuery] = useState("");
  const [effect, setEffect] = useState<ActionApprovalRule["effect"]>("require_approval");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const saves = useRef(0);
  const saving = useRef(false);
  const mounted = useRef(true);
  const editor = useRef(0);
  const lastToolParam = useRef(toolParam);
  const mode = settings?.mode ?? "ask";
  const name =
    tool === OTHER_TOOL
      ? (approvalRuleTool(otherTool)?.name ?? toolNameFromLabel(otherTool))
      : tool;
  const effects = approvalRuleEffects(name, mode);
  const selectedEffect = effects.includes(effect) ? effect : initialApprovalRuleEffect(name, mode);
  const visible = listSearch(APPROVAL_RULE_TOOLS, query, {
    text: (item) => `${item.label} ${item.name}`,
  }).visible;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      editor.current++;
    };
  }, []);
  useEffect(() => {
    if (lastToolParam.current === toolParam) return;
    lastToolParam.current = toolParam;
    editor.current++;
    const selected = approvalRuleTool(toolParam ?? "");
    setTool(selected?.name ?? "");
    setAdding(Boolean(selected));
    setOtherTool("");
    setQuery("");
    setError(null);
  }, [toolParam]);

  useFocusEffect(
    useCallback(() => {
      let current = true;
      const savesAtRead = saves.current;
      void Promise.all([rpc("approvalRules/list", { scope }), rpc("autoReview/get", { scope })])
        .then(([nextRules, nextSettings]) => {
          if (!current || saves.current !== savesAtRead) return;
          setRules(nextRules);
          setSettings(nextSettings);
          setLoadError(null);
        })
        .catch((err: unknown) => {
          if (current) setLoadError(errorText(err, t("Something went wrong. Try again.")));
        });
      return () => {
        current = false;
      };
    }, [attempt, rpc, scope, t]),
  );

  function closeEditor() {
    editor.current++;
    setAdding(false);
    setTool("");
    setOtherTool("");
    setQuery("");
    setError(null);
    if (toolParam) router.setParams({ tool: undefined });
  }

  async function save(change: (current: () => boolean) => Promise<void>) {
    if (saving.current) return;
    const owner = editor.current;
    const current = () => mounted.current && editor.current === owner;
    saves.current++;
    saving.current = true;
    setPending(true);
    setError(null);
    setLoadError(null);
    try {
      await change(current);
    } catch (err) {
      if (current()) setError(errorText(err, t("Could not save that preference")));
    } finally {
      saving.current = false;
      if (mounted.current) setPending(false);
    }
  }

  const applyRuleAction = (rule: ActionApprovalRule, action: RuleAction) =>
    save(async (current) => {
      if (action === "remove") {
        await rpc("approvalRules/remove", { scope, id: rule.id });
        if (current())
          setRules((entries) => entries?.filter((entry) => entry.id !== rule.id) ?? null);
        return;
      }
      if (
        action === rule.effect ||
        rule.matchKind === "category" ||
        !approvalRuleEffects(rule.matchValue, mode).includes(action)
      )
        return;
      const saved = await rpc("approvalRules/set", {
        scope,
        effect: action,
        matchKind: rule.matchKind,
        matchValue: rule.matchValue,
      });
      if (current())
        setRules((entries) =>
          (entries ?? []).map((entry) => (entry.id === rule.id ? saved : entry)),
        );
    });

  const addTool = () =>
    save(async (current) => {
      if (!name.trim()) return;
      const exists = rules?.some(
        (rule) => rule.matchKind === "tool" && rule.matchValue.toLowerCase() === name.toLowerCase(),
      );
      if (!exists) {
        const saved = await rpc("approvalRules/set", {
          scope,
          effect: selectedEffect,
          matchKind: "tool",
          matchValue: name,
        });
        if (current())
          setRules((entries) => [
            ...(entries ?? []).filter(
              (entry) =>
                entry.matchKind !== "tool" ||
                entry.matchValue.toLowerCase() !== saved.matchValue.toLowerCase(),
            ),
            saved,
          ]);
      }
      if (current()) closeEditor();
    });
  const addToolRef = useRef(addTool);
  addToolRef.current = addTool;
  const closeRef = useRef(closeEditor);
  closeRef.current = closeEditor;
  const canAdd = rules !== null && settings !== null && !loadError;

  useLayoutEffect(() => {
    const open = () => {
      editor.current++;
      setError(null);
      setQuery("");
      setTool("");
      setOtherTool("");
      setAdding(true);
    };
    const action = adding
      ? {
          label: t("Save"),
          onPress: () => void addToolRef.current(),
          disabled: pending || !name.trim(),
        }
      : { label: t("Add rule"), onPress: open, disabled: pending };
    const cancel = { label: t("Cancel"), onPress: () => closeRef.current() };
    navigation.setOptions(
      iosAtLeast(26)
        ? {
            unstable_headerRightItems: () =>
              canAdd ? [{ type: "button" as const, ...action }] : [],
            unstable_headerLeftItems: adding
              ? () => [{ type: "button" as const, ...cancel }]
              : undefined,
          }
        : {
            headerRight: () =>
              canAdd ? (
                <NativeActionButton fill={false} {...action} prominence="secondary" />
              ) : null,
            headerLeft: adding
              ? () => <NativeActionButton fill={false} {...cancel} prominence="secondary" />
              : undefined,
          },
    );
  }, [adding, canAdd, name, navigation, pending, t]);

  useLayoutEffect(() => {
    if (Platform.OS !== "ios") return;
    navigation.setOptions({
      headerSearchBarOptions:
        adding && tool !== OTHER_TOOL
          ? {
              placeholder: t("Search"),
              hideWhenScrolling: false,
              hideNavigationBar: false,
              autoCapitalize: "none",
              onChangeText: (event: { nativeEvent: { text: string } }) =>
                setQuery(event.nativeEvent.text),
              onCancelButtonPress: () => setQuery(""),
              onClose: () => setQuery(""),
            }
          : undefined,
    });
  }, [adding, tool, navigation, t]);

  const effectLabel = (value: ActionApprovalRule["effect"]) =>
    value === "always_allow" ? t("Allow") : value === "deny" ? t("Block") : t("Ask");
  const failure = error ?? loadError;
  return (
    <SafeAreaView edges={["bottom"]} style={styles.screen}>
      <ScrollView
        style={sideInsets}
        contentContainerStyle={styles.content}
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
      >
        {failure && !rules ? (
          <LoadFailure
            message={failure}
            onRetry={() => {
              setError(null);
              setLoadError(null);
              setAttempt((count) => count + 1);
            }}
          />
        ) : failure ? (
          <Text accessibilityRole="alert" style={styles.error}>
            {failure}
          </Text>
        ) : null}
        {adding ? (
          <>
            {name ? (
              <SettingsGroup>
                <MenuPicker
                  label={t("Rule")}
                  value={selectedEffect}
                  choices={effects.map((choice) => ({ key: choice, label: effectLabel(choice) }))}
                  onChange={(choice) => {
                    if (effects.includes(choice as ActionApprovalRule["effect"]))
                      setEffect(choice as ActionApprovalRule["effect"]);
                  }}
                />
              </SettingsGroup>
            ) : null}
            {hasSeparateComputerApproval(name) ? (
              <SettingsFooter>{t("Computer access is approved separately.")}</SettingsFooter>
            ) : null}
            {mode === "never" ? (
              <SettingsFooter>{t("Ask rules are inactive in Never ask.")}</SettingsFooter>
            ) : null}
            {tool === OTHER_TOOL ? (
              <SettingsGroup>
                <SettingsInputRow
                  accessibilityLabel={t("Integration tool")}
                  placeholder={t("Integration tool")}
                  value={otherTool}
                  onChangeText={setOtherTool}
                  autoCapitalize="none"
                  autoCorrect={false}
                  maxLength={253}
                />
              </SettingsGroup>
            ) : (
              <>
                {Platform.OS === "android" ? (
                  <ListSearchInput query={query} setQuery={setQuery} />
                ) : null}
                <SettingsGroup>
                  {visible.map((item) => (
                    <SettingsRow
                      key={item.name}
                      title={item.label}
                      onPress={() => {
                        setTool(item.name);
                        setEffect(initialApprovalRuleEffect(item.name, mode));
                      }}
                      trailing={tool === item.name ? <Checkmark /> : undefined}
                    />
                  ))}
                </SettingsGroup>
                {visible.length === 0 ? (
                  <Text accessibilityRole="alert">{t("No tools found.")}</Text>
                ) : null}
                <SettingsGroup>
                  <SettingsRow
                    title={t("Other tool")}
                    onPress={() => {
                      setTool(OTHER_TOOL);
                      setEffect(initialApprovalRuleEffect("", mode));
                    }}
                  />
                </SettingsGroup>
              </>
            )}
          </>
        ) : (
          <>
            {mode === "never" && rules?.some((rule) => rule.effect === "require_approval") ? (
              <SettingsFooter>{t("Ask rules are inactive in Never ask.")}</SettingsFooter>
            ) : null}
            <SettingsGroup>
              {rules?.map((rule) => {
                const title =
                  rule.matchKind === "tool" ? humanizeToolName(rule.matchValue) : rule.matchValue;
                const choices =
                  rule.matchKind === "category" ? [] : approvalRuleEffects(rule.matchValue, mode);
                const inactive = rule.matchKind !== "category" && !choices.includes(rule.effect);
                return (
                  <MenuView
                    key={rule.id}
                    actions={[
                      ...choices.map((choice) => ({
                        id: choice,
                        title: effectLabel(choice),
                        state: rule.effect === choice ? ("on" as const) : ("off" as const),
                      })),
                      { id: "remove", title: t("Remove"), attributes: { destructive: true } },
                    ]}
                    colorScheme={colorScheme}
                    title={title}
                    onPressAction={(event) => {
                      const action = event.nativeEvent.event;
                      if (!pending && isRuleAction(action)) void applyRuleAction(rule, action);
                    }}
                  >
                    <SettingsRow
                      accessible
                      accessibilityRole="button"
                      dimmed={pending}
                      title={title}
                      value={effectLabel(rule.effect)}
                      detail={inactive ? t("Inactive") : undefined}
                    />
                  </MenuView>
                );
              })}
            </SettingsGroup>
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function isRuleAction(action: string): action is RuleAction {
  return (
    action === "always_allow" ||
    action === "require_approval" ||
    action === "deny" ||
    action === "remove"
  );
}

function createStyles() {
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: native.groupedPage },
    content: { width: "100%", padding: 20, gap: 24, paddingBottom: 40 },
    error: { color: mobileTokens().destructive, fontSize: 14 },
  });
}
