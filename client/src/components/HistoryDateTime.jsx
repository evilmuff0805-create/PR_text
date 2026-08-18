const DATE_FORMATTER = new Intl.DateTimeFormat('ko-KR', {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

const TIME_FORMATTER = new Intl.DateTimeFormat('ko-KR', {
  hour: '2-digit',
  minute: '2-digit',
  hour12: true,
});

export default function HistoryDateTime({ value }) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return <span>-</span>;

  const dateText = DATE_FORMATTER.format(date);
  const timeText = TIME_FORMATTER.format(date);

  return (
    <time
      className="usage-date-time"
      dateTime={value}
      aria-label={`${dateText} ${timeText}`}
    >
      <span>{dateText}</span>
      <span>{timeText}</span>
    </time>
  );
}
