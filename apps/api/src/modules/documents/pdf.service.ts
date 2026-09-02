import PDFDocument from 'pdfkit';
import QRCode from 'qrcode';
import { getEnv } from '../../config/env.ts';
import { decryptField } from '../../lib/crypto.ts';

/**
 * Prescription, referral and consultation-summary PDFs (spec §43, §49, D7, D25).
 *
 * PDFKit rather than a headless browser: server-side, deterministic, no
 * Chromium dependency, and no HTML template that could be injected into. These
 * are structured legal documents, not web pages, and exact reproducibility
 * matters more than layout convenience (decision D7).
 *
 * Two things every document here carries:
 *
 *  - **The consultation reference**, because under D24 it is how a patient
 *    identifies their own record and the only key that locates it later.
 *  - **A verification QR code**, so a pharmacy or hospital shown the document
 *    can confirm it is genuine rather than taking a printout on trust.
 *
 * Nothing here states or implies regulatory approval (spec §78).
 */

const PAGE_MARGIN = 50;
const BRAND = '#0F766E';
const INK = '#0F172A';
const MUTED = '#64748B';

interface DocumentChrome {
  title: string;
  /** The consultation reference, printed on every document (D24). */
  consultationReference: string;
  verificationUrl: string;
  issuedAt: Date;
}

/** Height reserved at the foot of every page for the footer band. */
const FOOTER_BAND = 88;

/**
 * Collects a PDFKit stream into one buffer, then stamps the footer.
 *
 * The bottom margin reserves `FOOTER_BAND`, so flowing content breaks to a new
 * page before it can reach the footer. The footer is drawn afterwards on every
 * page — a long prescription legitimately runs to two pages, and each one must
 * carry the consultation reference and the verification address.
 *
 * Drawing it inline produced a spurious second page whenever the footer text
 * overflowed the last line of content, which it did for a two-item
 * prescription.
 */
function render(
  chrome: DocumentChrome,
  note: string,
  build: (doc: PDFKit.PDFDocument) => Promise<void> | void,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      margins: {
        top: PAGE_MARGIN,
        left: PAGE_MARGIN,
        right: PAGE_MARGIN,
        bottom: PAGE_MARGIN + FOOTER_BAND,
      },
      bufferPages: true,
    });
    const chunks: Buffer[] = [];

    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    void Promise.resolve(build(doc))
      .then(() => {
        const range = doc.bufferedPageRange();
        for (let page = range.start; page < range.start + range.count; page += 1) {
          doc.switchToPage(page);
          drawFooter(
            doc,
            chrome,
            note,
            range.count > 1 ? `${page - range.start + 1}/${range.count}` : null,
          );
        }
        doc.flushPages();
        doc.end();
      })
      .catch(reject);
  });
}

async function drawHeader(doc: PDFKit.PDFDocument, chrome: DocumentChrome): Promise<void> {
  doc.fillColor(BRAND).fontSize(20).font('Helvetica-Bold').text('Neem', PAGE_MARGIN, PAGE_MARGIN);
  doc
    .fillColor(MUTED)
    .fontSize(8)
    .font('Helvetica')
    .text('Pharmacy-based telemedicine', PAGE_MARGIN, doc.y + 2);

  doc
    .fillColor(INK)
    .fontSize(16)
    .font('Helvetica-Bold')
    .text(chrome.title, PAGE_MARGIN, PAGE_MARGIN + 46);

  // The QR sits top-right and encodes only the verification URL — no patient
  // data, no clinical content (spec §60).
  const qr = await QRCode.toBuffer(chrome.verificationUrl, { margin: 0, width: 220 });
  doc.image(qr, doc.page.width - PAGE_MARGIN - 78, PAGE_MARGIN, { width: 78 });
  doc
    .fillColor(MUTED)
    .fontSize(6.5)
    .font('Helvetica')
    .text('Scan to verify', doc.page.width - PAGE_MARGIN - 78, PAGE_MARGIN + 82, {
      width: 78,
      align: 'center',
    });

  doc.moveTo(PAGE_MARGIN, PAGE_MARGIN + 108)
    .lineTo(doc.page.width - PAGE_MARGIN, PAGE_MARGIN + 108)
    .strokeColor('#E2E8F0')
    .stroke();

  doc.y = PAGE_MARGIN + 122;
  doc.x = PAGE_MARGIN;
}

function labelledRow(doc: PDFKit.PDFDocument, pairs: Array<[string, string]>): void {
  const columnWidth = (doc.page.width - PAGE_MARGIN * 2) / pairs.length;

  const top = doc.y;
  pairs.forEach(([label, value], index) => {
    const x = PAGE_MARGIN + index * columnWidth;
    doc.fillColor(MUTED).fontSize(7.5).font('Helvetica-Bold').text(label.toUpperCase(), x, top, {
      width: columnWidth - 10,
    });
    doc.fillColor(INK).fontSize(10).font('Helvetica').text(value, x, top + 11, {
      width: columnWidth - 10,
    });
  });

  doc.x = PAGE_MARGIN;
  doc.y = top + 32;
}

function sectionHeading(doc: PDFKit.PDFDocument, text: string): void {
  doc.moveDown(0.4);
  doc
    .fillColor(BRAND)
    .fontSize(9)
    .font('Helvetica-Bold')
    .text(text.toUpperCase(), PAGE_MARGIN, doc.y);
  doc.moveDown(0.3);
  doc.fillColor(INK).fontSize(10).font('Helvetica');
}

function paragraph(doc: PDFKit.PDFDocument, text: string): void {
  doc
    .fillColor(INK)
    .fontSize(10)
    .font('Helvetica')
    .text(text, PAGE_MARGIN, doc.y, { width: doc.page.width - PAGE_MARGIN * 2, align: 'left' });
  doc.moveDown(0.4);
}

/**
 * The signature block.
 *
 * The image is the doctor's own drawn signature, decrypted for rendering and
 * never written anywhere but into this PDF. If it cannot be decoded the
 * document still issues, with the doctor's name and MDC number — a missing
 * image must not block a prescription a patient is waiting for.
 */
function drawSignature(
  doc: PDFKit.PDFDocument,
  doctor: { fullName: string; mdcNumber: string },
  signatureDataUrl: string | null,
): void {
  /**
   * Flows after the content rather than being pinned to the page foot.
   *
   * Pinned, a long prescription's items ran underneath it. If the block will
   * not fit on this page a new one starts — a signature split across a page
   * break is not a signature.
   */
  const BLOCK_HEIGHT = 96;
  if (doc.y + BLOCK_HEIGHT > doc.page.height - PAGE_MARGIN - FOOTER_BAND) {
    doc.addPage();
  }

  const top = doc.y + 16;
  doc.y = top;

  if (signatureDataUrl) {
    try {
      const base64 = signatureDataUrl.split(',')[1] ?? '';
      doc.image(Buffer.from(base64, 'base64'), PAGE_MARGIN, top, { fit: [170, 55] });
    } catch {
      // Fall through to the printed name.
    }
  }

  doc.moveTo(PAGE_MARGIN, top + 62).lineTo(PAGE_MARGIN + 200, top + 62).strokeColor('#94A3B8').stroke();
  doc.fillColor(INK).fontSize(10).font('Helvetica-Bold').text(doctor.fullName, PAGE_MARGIN, top + 68);
  doc
    .fillColor(MUTED)
    .fontSize(8)
    .font('Helvetica')
    .text(`MDC ${doctor.mdcNumber}`, PAGE_MARGIN, doc.y + 1);
}

function drawFooter(
  doc: PDFKit.PDFDocument,
  chrome: DocumentChrome,
  note: string,
  pageLabel: string | null,
): void {
  const width = doc.page.width - PAGE_MARGIN * 2;
  const top = doc.page.height - PAGE_MARGIN - FOOTER_BAND + 8;

  /**
   * The footer writes *inside* the band the content margin reserves, which is
   * below `margins.bottom`. PDFKit treats any text starting past that boundary
   * as an overflow and silently appends a page — which is exactly what turned
   * a one-page prescription into three.
   *
   * Suppressing the bottom margin for the duration is the documented way to
   * draw in the reserved band. Restored immediately, so nothing else is
   * affected.
   */
  const reserved = doc.page.margins.bottom;
  doc.page.margins.bottom = 0;

  doc
    .moveTo(PAGE_MARGIN, top)
    .lineTo(doc.page.width - PAGE_MARGIN, top)
    .strokeColor('#E2E8F0')
    .stroke();

  doc.fillColor(MUTED).fontSize(7.5).font('Helvetica').text(note, PAGE_MARGIN, top + 8, { width });

  doc.fontSize(7.5).text(
    `Consultation reference ${chrome.consultationReference}  ·  Issued ${chrome.issuedAt
      .toISOString()
      .slice(0, 10)}  ·  Verify at ${chrome.verificationUrl}` +
      (pageLabel ? `  ·  Page ${pageLabel}` : ''),
    PAGE_MARGIN,
    top + 46,
    { width },
  );

  doc.page.margins.bottom = reserved;
}

/**
 * The small print. Kept together so the three documents can be read side by
 * side: none claims regulatory approval or endorsement (spec §78), and each
 * says plainly that the assessment was remote.
 */
const FOOTER_NOTES = {
  prescription:
    'This prescription was issued after a remote consultation conducted through Neem. Its ' +
    'authenticity can be confirmed at the address below. Neem makes no claim of regulatory ' +
    'approval or endorsement.',
  referral:
    'This referral follows a remote consultation through Neem. The assessment was made without ' +
    'physical examination; please assess the patient independently. Neem makes no claim of ' +
    'regulatory approval or endorsement.',
  summary:
    'This is a summary of one remote consultation, not a medical report and not a complete ' +
    'medical record. The assessment was made without physical examination. Neem makes no claim ' +
    'of regulatory approval or endorsement.',
} as const;

function verificationUrl(kind: 'rx' | 'referral' | 'summary', code: string): string {
  return `${getEnv().WEB_ORIGIN}/verify/${kind}/${code}`;
}

// ---------------------------------------------------------------------------
// Prescription
// ---------------------------------------------------------------------------

export interface PrescriptionPdfInput {
  publicId: string;
  verificationCode: string;
  consultationReference: string;
  issuedAt: Date;
  patient: { name: string; age: number; sex: string };
  doctor: { fullName: string; mdcNumber: string };
  pharmacy: { name: string; city: string };
  signatureDataEnc: string | null;
  items: Array<{
    medication: string;
    strength: string | null;
    form: string | null;
    dose: string;
    frequency: string;
    durationText: string;
    quantity: string;
    instructions: string | null;
    isActive: boolean;
    supersededBy?: string | null;
  }>;
}

export function renderPrescriptionPdf(input: PrescriptionPdfInput): Promise<Buffer> {
  const chrome: DocumentChrome = {
    title: 'Prescription',
    consultationReference: input.consultationReference,
    verificationUrl: verificationUrl('rx', input.verificationCode),
    issuedAt: input.issuedAt,
  };

  return render(chrome, FOOTER_NOTES.prescription, async (doc) => {
    await drawHeader(doc, chrome);

    labelledRow(doc, [
      ['Patient', input.patient.name],
      ['Age', String(input.patient.age)],
      ['Sex', input.patient.sex],
    ]);
    labelledRow(doc, [
      ['Prescription', input.publicId],
      ['Pharmacy', `${input.pharmacy.name}, ${input.pharmacy.city}`],
    ]);

    sectionHeading(doc, 'Medication');

    for (const item of input.items) {
      // A superseded item stays on the document rather than vanishing: the
      // record must show what was prescribed as well as what replaced it.
      const superseded = !item.isActive;

      doc
        .fillColor(superseded ? MUTED : INK)
        .fontSize(11)
        .font('Helvetica-Bold')
        .text(
          [item.medication, item.strength, item.form].filter(Boolean).join(' · ') +
            (superseded ? '   (replaced by substitution)' : ''),
          PAGE_MARGIN,
          doc.y,
          { width: doc.page.width - PAGE_MARGIN * 2 },
        );

      doc
        .fillColor(superseded ? MUTED : INK)
        .fontSize(9.5)
        .font('Helvetica')
        .text(
          `${item.dose} · ${item.frequency} · ${item.durationText} · Quantity: ${item.quantity}`,
          PAGE_MARGIN + 10,
          doc.y + 2,
          { width: doc.page.width - PAGE_MARGIN * 2 - 10 },
        );

      if (item.instructions) {
        doc
          .fillColor(MUTED)
          .fontSize(9)
          .font('Helvetica-Oblique')
          .text(item.instructions, PAGE_MARGIN + 10, doc.y + 1, {
            width: doc.page.width - PAGE_MARGIN * 2 - 10,
          });
      }

      doc.moveDown(0.7);
    }

    drawSignature(
      doc,
      input.doctor,
      input.signatureDataEnc ? decryptField(input.signatureDataEnc) : null,
    );

  });
}

// ---------------------------------------------------------------------------
// Referral
// ---------------------------------------------------------------------------

export interface ReferralPdfInput {
  publicId: string;
  verificationCode: string;
  consultationReference: string;
  issuedAt: Date;
  patient: { name: string; age: number; sex: string };
  doctor: { fullName: string; mdcNumber: string };
  hospitalName: string;
  department: string;
  urgency: string | null;
  reasonText: string;
  signatureDataEnc: string | null;
}

export function renderReferralPdf(input: ReferralPdfInput): Promise<Buffer> {
  const chrome: DocumentChrome = {
    title: 'Referral',
    consultationReference: input.consultationReference,
    verificationUrl: verificationUrl('referral', input.verificationCode),
    issuedAt: input.issuedAt,
  };

  return render(chrome, FOOTER_NOTES.referral, async (doc) => {
    await drawHeader(doc, chrome);

    if (input.urgency && /urgent|emergency/i.test(input.urgency)) {
      // Prominent, because a referral that is time-critical must not read the
      // same as a routine one at a busy reception desk.
      doc.rect(PAGE_MARGIN, doc.y, doc.page.width - PAGE_MARGIN * 2, 24).fill('#FEE2E2');
      doc
        .fillColor('#991B1B')
        .fontSize(11)
        .font('Helvetica-Bold')
        .text(input.urgency.toUpperCase(), PAGE_MARGIN + 10, doc.y - 17);
      doc.y += 14;
      doc.x = PAGE_MARGIN;
    }

    labelledRow(doc, [
      ['Patient', input.patient.name],
      ['Age', String(input.patient.age)],
      ['Sex', input.patient.sex],
    ]);
    labelledRow(doc, [
      ['Referred to', input.hospitalName],
      ['Department', input.department],
    ]);

    sectionHeading(doc, 'Reason for referral');
    paragraph(doc, input.reasonText);

    drawSignature(
      doc,
      input.doctor,
      input.signatureDataEnc ? decryptField(input.signatureDataEnc) : null,
    );

  });
}

// ---------------------------------------------------------------------------
// Consultation summary (decision D25)
// ---------------------------------------------------------------------------

export interface SummaryPdfInput {
  publicId: string;
  verificationCode: string;
  consultationReference: string;
  issuedAt: Date;
  patient: { name: string; age: number; sex: string };
  doctor: { fullName: string; mdcNumber: string };
  pharmacy: { name: string; city: string };
  presentingComplaint: string;
  assessment: string;
  advice: string;
  safetyNetting: string;
  signatureDataEnc: string | null;
}

/**
 * The consultation summary.
 *
 * Deliberately **not** titled "medical report": in Ghana that phrase is used
 * for employment, insurance and court purposes, and naming it so would invite
 * it being presented as something a remote five-minute assessment cannot
 * support (decision D25).
 *
 * The safety-netting section is rendered prominently rather than as a footnote,
 * because it is the part that matters clinically — a summary saying only "no
 * medication needed" reads as an all-clear.
 */
export function renderSummaryPdf(input: SummaryPdfInput): Promise<Buffer> {
  const chrome: DocumentChrome = {
    title: 'Consultation summary',
    consultationReference: input.consultationReference,
    verificationUrl: verificationUrl('summary', input.verificationCode),
    issuedAt: input.issuedAt,
  };

  return render(chrome, FOOTER_NOTES.summary, async (doc) => {
    await drawHeader(doc, chrome);

    labelledRow(doc, [
      ['Patient', input.patient.name],
      ['Age', String(input.patient.age)],
      ['Sex', input.patient.sex],
    ]);
    labelledRow(doc, [
      ['Summary', input.publicId],
      ['Pharmacy', `${input.pharmacy.name}, ${input.pharmacy.city}`],
    ]);

    sectionHeading(doc, 'What you came in with');
    paragraph(doc, input.presentingComplaint);

    sectionHeading(doc, 'Assessment');
    paragraph(doc, input.assessment);

    sectionHeading(doc, 'Advice given');
    paragraph(doc, input.advice);

    // Boxed and last, so it is the thing the patient's eye lands on.
    doc.moveDown(0.3);
    const boxTop = doc.y;
    doc
      .fillColor('#92400E')
      .fontSize(9)
      .font('Helvetica-Bold')
      .text('WHAT TO WATCH FOR, AND WHEN TO SEEK CARE', PAGE_MARGIN + 12, boxTop + 10, {
        width: doc.page.width - PAGE_MARGIN * 2 - 24,
      });
    doc
      .fillColor(INK)
      .fontSize(10)
      .font('Helvetica')
      .text(input.safetyNetting, PAGE_MARGIN + 12, doc.y + 3, {
        width: doc.page.width - PAGE_MARGIN * 2 - 24,
      });

    const boxHeight = doc.y - boxTop + 12;
    doc
      .rect(PAGE_MARGIN, boxTop, doc.page.width - PAGE_MARGIN * 2, boxHeight)
      .strokeColor('#F59E0B')
      .lineWidth(1)
      .stroke();
    doc.y = boxTop + boxHeight + 6;

    drawSignature(
      doc,
      input.doctor,
      input.signatureDataEnc ? decryptField(input.signatureDataEnc) : null,
    );

  });
}
