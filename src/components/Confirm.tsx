import { useEffect, useState } from 'react';
import { Text, useInput } from 'ink';

type ConfirmProps = {
  question: string;
  onConfirm: (answer: boolean) => void;
};

const isTTY = Boolean(process.stdin.isTTY);

export function Confirm({ question, onConfirm }: ConfirmProps) {
  const [answered, setAnswered] = useState(false);
  const [answer, setAnswer] = useState<boolean | null>(null);

  // Non-interactive fallback: auto-confirm yes when stdin is not a TTY
  useEffect(() => {
    if (!isTTY && !answered) {
      setAnswer(true);
      setAnswered(true);
      onConfirm(true);
    }
  }, []);

  useInput(
    (input, key) => {
      if (answered) return;

      if (input === 'y' || input === 'Y') {
        setAnswer(true);
        setAnswered(true);
        onConfirm(true);
      } else if (input === 'n' || input === 'N' || key.escape) {
        setAnswer(false);
        setAnswered(true);
        onConfirm(false);
      }
    },
    { isActive: !answered && isTTY },
  );

  if (!answered) {
    return (
      <Text>
        {question}
        <Text dimColor>{' [y/n] '}</Text>
      </Text>
    );
  }

  return (
    <Text>
      {question}{' '}
      {answer === true ? (
        <Text color="green">yes</Text>
      ) : (
        <Text dimColor>no</Text>
      )}
    </Text>
  );
}
