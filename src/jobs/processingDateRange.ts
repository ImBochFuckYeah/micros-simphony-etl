export interface ProcessingDateRange {
  startDate: string;
  endDate: string;
}

export const formatDateOnly = (date: Date): string => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
};

export const parseDateInput = (value: string | Date): Date => {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      throw new Error("Invalid date value provided");
    }

    return new Date(value.getFullYear(), value.getMonth(), value.getDate());
  }

  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!match) {
    throw new Error(`Invalid date format '${value}'. Expected YYYY-MM-DD`);
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const parsed = new Date(year, month - 1, day);

  if (
    Number.isNaN(parsed.getTime()) ||
    parsed.getFullYear() !== year ||
    parsed.getMonth() !== month - 1 ||
    parsed.getDate() !== day
  ) {
    throw new Error(`Invalid date value '${value}'`);
  }

  return parsed;
};

const toDateOnly = (date: Date): Date => new Date(date.getFullYear(), date.getMonth(), date.getDate());

const subtractDays = (date: Date, days: number): Date => {
  const normalized = toDateOnly(date);
  normalized.setDate(normalized.getDate() - days);
  return normalized;
};

export const resolveProcessingDateRange = (
  startDateInput?: string | Date,
  endDateInput?: string | Date,
  referenceDate: Date = new Date()
): ProcessingDateRange => {
  const defaultStartDate = subtractDays(referenceDate, 1);
  const start = startDateInput ? parseDateInput(startDateInput) : defaultStartDate;
  const end = endDateInput ? parseDateInput(endDateInput) : start;

  if (end < start) {
    throw new Error("endDate must be greater than or equal to startDate");
  }

  return {
    startDate: formatDateOnly(start),
    endDate: formatDateOnly(end)
  };
};
