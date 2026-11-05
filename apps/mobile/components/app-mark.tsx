// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Rakazo contributors
// SPDX-FileCopyrightText: 2026 Ork contributors
// Modified by Ork contributors to display the full new mark without the inherited face crop.
// Inherited theme and accessibility handling remain Apache-2.0. New changes follow LICENSE.md.

import { Image, StyleSheet, View } from "react-native";
import appMark from "../assets/monochrome-icon.png";
import { native, useThemedStyles } from "../lib/native";

const MARK = 56;

export function AppMark() {
  const styles = useThemedStyles(createAppMarkStyles);
  return (
    <View
      accessible={false}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={styles.frame}
    >
      <Image source={appMark} style={styles.image} resizeMode="contain" />
    </View>
  );
}

function createAppMarkStyles() {
  return StyleSheet.create({
    frame: {
      width: MARK,
      height: MARK,
      alignSelf: "center",
    },
    image: {
      width: MARK,
      height: MARK,
      tintColor: native.label,
    },
  });
}
