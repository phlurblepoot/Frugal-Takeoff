import type { CustomerRoleEmails } from '../types';

export type TemplateType = 'proposal' | 'invoice' | 'changeOrder' | 'issue' | 'punch';

export function roleForTemplate(t: TemplateType): keyof CustomerRoleEmails {
  switch (t) {
    case 'proposal': return 'estimating';
    case 'invoice':
    case 'changeOrder': return 'accounting';
    case 'issue':
    case 'punch': return 'pm';
  }
}

/** project[role] -> customer[role] -> project.general -> customer.general -> ''. */
export function resolveRecipient(
  t: TemplateType,
  projectEmails: CustomerRoleEmails | undefined,
  customerEmails: CustomerRoleEmails | undefined,
): string {
  const role = roleForTemplate(t);
  return (
    projectEmails?.[role] || customerEmails?.[role] ||
    projectEmails?.general || customerEmails?.general || ''
  ).trim();
}
