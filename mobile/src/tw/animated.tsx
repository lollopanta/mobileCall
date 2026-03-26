// Remove circular dependency on index.tsx
import RNAnimated from "react-native-reanimated";
import { View as RNView } from "react-native";
import { useCssElement } from "react-native-css";

const CSSView = (props: any) => {
  return useCssElement(RNView, props, { className: "style" });
};

export const Animated = {
  ...RNAnimated,
  View: RNAnimated.createAnimatedComponent(CSSView),
};
