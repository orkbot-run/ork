// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { Trans, useLingui } from "@lingui/react/macro";
import { APPROVAL_RULE_TOOLS, approvalRuleTool } from "@orkbot/core";
import {
  Button,
  Command,
  CommandGroup,
  CommandItem,
  CommandList,
  ListSearchInput,
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@orkbot/ui-web";
import { useRef, useState } from "react";
import { useListSearch } from "../lib/use-list-search";

export const OTHER_APPROVAL_TOOL = "__other__";

export function ApprovalRuleToolPicker({
  value,
  onChange,
  disabled,
}: {
  value: string;
  onChange: (name: string) => void;
  disabled?: boolean;
}) {
  const { t } = useLingui();
  const [open, setOpen] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const { query, setQuery, visible } = useListSearch(APPROVAL_RULE_TOOLS, {
    text: (tool) => `${tool.label} ${tool.name}`,
  });
  const pick = (name: string) => {
    onChange(name);
    setOpen(false);
    setQuery("");
  };
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setQuery("");
      }}
    >
      <PopoverTrigger
        render={
          <Button
            type="button"
            variant="outline"
            disabled={disabled}
            className="min-w-40 justify-start"
          />
        }
        aria-label={t`Tool`}
      >
        {value === OTHER_APPROVAL_TOOL
          ? t`Other tool`
          : (approvalRuleTool(value)?.label ?? t`Choose a tool`)}
      </PopoverTrigger>
      <PopoverContent initialFocus={searchRef} className="gap-0 p-0" align="start">
        <Command label={t`Tools`} shouldFilter={false}>
          <ListSearchInput
            command
            inputRef={searchRef}
            label={t`Search tools`}
            placeholder={t`Search`}
            query={query}
            setQuery={setQuery}
          />
          <CommandList label={t`Tools`}>
            <CommandGroup>
              {visible.map((tool) => (
                <CommandItem key={tool.name} value={tool.name} onSelect={() => pick(tool.name)}>
                  {tool.label}
                </CommandItem>
              ))}
              {visible.length === 0 ? (
                <p role="status" className="p-3 text-sm text-muted-foreground">
                  <Trans>No tools found.</Trans>
                </p>
              ) : null}
            </CommandGroup>
            <CommandGroup>
              <CommandItem value={OTHER_APPROVAL_TOOL} onSelect={() => pick(OTHER_APPROVAL_TOOL)}>
                <Trans>Other tool</Trans>
              </CommandItem>
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
