-- Contract length in months per service (1 = monthly rolling, 12 = yearly, ...).
-- Used to calculate the end date from the start date.
alter table services
  add column if not exists contract_term_months integer;
