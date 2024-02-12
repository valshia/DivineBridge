import { OCRTypes } from '../types.js';

export class ThaBillingDateParser implements OCRTypes.BillingDateParser {
  constructor(public readonly language: 'tha') {}
  parse(lines: string[]): OCRTypes.RecognizedDate {
    const regex =
      /เรียกเก็บเงินครั้งถัดไปในวันที่(\d{1,2})(ม.ค.|ก.พ.|มี.ค.|เม.ย.|พ.ค.|มิ.ย.|ก.ค.|ส.ค.|ก.ย.|ต.ค.|พ.ย.|ธ.ค.)(\d{4})/;
    for (const line of lines) {
      const match = line.match(regex);
      if (match !== null) {
        const abbreviatedMonth = match[2];
        const monthMap: Record<string, number> = {
          'ม.ค.': 1,
          'ก.พ.': 2,
          'มี.ค.': 3,
          'เม.ย.': 4,
          'พ.ค.': 5,
          'มิ.ย.': 6,
          'ก.ค.': 7,
          'ส.ค.': 8,
          'ก.ย.': 9,
          'ต.ค.': 10,
          'พ.ย.': 11,
          'ธ.ค.': 12,
        };
        const month = monthMap[abbreviatedMonth];
        const [day, , year] = match.slice(1, 4).map((s) => parseInt(s, 10));
        return { year, month, day };
      }
    }
    return OCRTypes.BillingDateParser.emptyDate;
  }
}
