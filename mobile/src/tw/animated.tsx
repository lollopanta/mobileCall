// Remove circular dependency on index.tsx
import React from "react";
import RNAnimated from "react-native-reanimated";
import { View as RNView } from "react-native";
import { useCssElement } from "react-native-css";

const CSSView = (props: React.ComponentProps<typeof RNView> & { className?: string }): React.ReactElement => {
  // Only style participates in CSS mapping; retain full View props above.
  return useCssElement<React.ComponentType<{ style?: object }>>(RNView, props, { className: "style" });
};

export const Animated = {
  ...RNAnimated,
  View: RNAnimated.createAnimatedComponent(CSSView),
};
