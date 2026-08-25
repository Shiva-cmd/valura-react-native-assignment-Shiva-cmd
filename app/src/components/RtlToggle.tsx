// B7 (optional): I18nManager.forceRTL mirrors layout natively across the
// whole tree. Numerals and the chart deliberately do not mirror - prices
// read left-to-right and the chart's time axis still runs oldest-to-newest
// regardless of writing direction, which is what a real Arabic-market build
// does (see README).
//
// forceRTL only takes full effect after the native layer reloads, same as
// any I18nManager change in RN - there is no way around that from JS.

import { Pressable, Text, StyleSheet, I18nManager, Alert } from 'react-native';

export function RtlToggle() {
  const onPress = () => {
    const next = !I18nManager.isRTL;
    I18nManager.allowRTL(true);
    I18nManager.forceRTL(next);
    Alert.alert(
      'Restart required',
      `RTL is now ${next ? 'enabled' : 'disabled'}. Reload the app for layout mirroring to take effect.`,
    );
  };

  return (
    <Pressable onPress={onPress} style={styles.button}>
      <Text style={styles.label}>{I18nManager.isRTL ? 'RTL: On' : 'RTL: Off'}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 8,
    backgroundColor: '#1C1C1E',
  },
  label: {
    color: '#8E8E93',
    fontSize: 11,
    fontWeight: '600',
  },
});
