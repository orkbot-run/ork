/** @jsxRuntime automatic */
// Modified by Ork contributors: canonical domain links now use ork.run.
import type { TransactionalEmail } from "@orkbot/adapter-kit";
import { ANDROID_APP_STORE_URL, IOS_APP_STORE_URL } from "@orkbot/contracts";
import { Link, Text } from "react-email";
import { emailText, greeting, linkStyle, message } from "./email.js";

const APPS: Readonly<Record<string, string>> = {
  iPhone: IOS_APP_STORE_URL,
  Android: ANDROID_APP_STORE_URL,
  Mac: "https://ork.run/api/download?platform=mac",
  Windows: "https://ork.run/api/download?platform=windows",
  Linux: "https://ork.run/api/download?platform=linux",
};

export function welcomeEmail(
  user: { email: string; name: string },
  unsubscribeUrl: string,
  locale = "en",
): Promise<TransactionalEmail> {
  const say = emailText(locale);
  return message(
    user.email,
    locale,
    say("Welcome to Ork"),
    <>
      <Text>{greeting(say, user.name)}</Text>
      <Text>{say("Thanks for signing up for Ork.")}</Text>
      <Text>
        {say("Ork also has apps for")}{" "}
        {/* The language's own list ("A, B, and C", "A, B y C"), with each app a link. */}
        {new Intl.ListFormat(locale, { type: "conjunction" })
          .formatToParts(Object.keys(APPS))
          .map((part, index) =>
            part.type === "element" ? (
              <Link key={part.value} href={APPS[part.value]} style={linkStyle}>
                {part.value}
              </Link>
            ) : (
              <span key={`${index}${part.value}`}>{part.value}</span>
            ),
          )}
        .
      </Text>
      <Text>
        {say("Questions or ideas?")}{" "}
        <Link href="https://github.com/orkbot-run/ork/issues" style={linkStyle}>
          GitHub
        </Link>
        .
      </Text>
      <Text>
        {say("Ork is open source. If you like it,")}{" "}
        <Link href="https://github.com/orkbot-run/ork" style={linkStyle}>
          {say("a star on GitHub")}
        </Link>{" "}
        {say("helps others find it.")}
      </Text>
      <Text>
        {say("Want to run it on your own servers?")}{" "}
        <Link
          href="https://github.com/orkbot-run/ork/blob/main/docs/self-host.md"
          style={linkStyle}
        >
          {say("Self-host Ork")}
        </Link>
        .
      </Text>
      <Text>{say("Have any questions? Reply to this email.")}</Text>
      <Text>Ork</Text>
    </>,
    unsubscribeUrl,
  );
}
