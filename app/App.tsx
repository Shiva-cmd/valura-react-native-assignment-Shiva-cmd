import { StatusBar } from 'expo-status-bar';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { TradingScreen } from './src/TradingScreen';

export default function App() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <TradingScreen />
      <StatusBar style="light" />
    </GestureHandlerRootView>
  );
}
