import { Box, Text } from 'ink';

export function Header() {
  return (
    <Box
      flexDirection="column"
      alignItems="center"
      borderStyle="round"
      borderColor="cyan"
      paddingX={4}
      paddingY={1}
      marginBottom={1}
    >
      <Text bold color="cyan">
        a g e n t g i t
      </Text>
      <Text dimColor color="blue">
        Claude Code session visualizer
      </Text>
    </Box>
  );
}
