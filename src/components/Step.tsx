import { Text } from 'ink';
import Spinner from 'ink-spinner';

type StepStatus = 'pending' | 'running' | 'done' | 'error';

type StepProps = {
  label: string;
  status: StepStatus;
  detail?: string;
};

export function Step({ label, status, detail }: StepProps) {
  if (status === 'pending') {
    return (
      <Text dimColor>
        {'·  '}
        {label}
      </Text>
    );
  }

  if (status === 'running') {
    return (
      <Text color="cyan">
        <Spinner type="dots" />
        {' '}
        {label}
      </Text>
    );
  }

  if (status === 'done') {
    return (
      <Text>
        <Text color="green">{'✓  '}</Text>
        <Text>{label}</Text>
        {detail !== undefined && (
          <Text dimColor>{' ' + detail}</Text>
        )}
      </Text>
    );
  }

  // error
  return (
    <Text>
      <Text color="red">{'✗  '}</Text>
      <Text color="red">{label}</Text>
      {detail !== undefined && (
        <Text color="red" dimColor>{' ' + detail}</Text>
      )}
    </Text>
  );
}
