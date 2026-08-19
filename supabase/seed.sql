insert into public.trial_files
  (last_name, first_name, device, loan_type, queue_date, vocabulary, notes, priority, status, lane)
values
  ('Lerum *F2F*', 'Jameson T', 'Talk Pad Wego 10', 'CL Replacement', '2026-05-04', '', '', 'EXPEDITE', 'Complete', 'Expedites'),
  ('Boykin', 'Areyah L', 'Wego 7A', 'SL', '2026-05-05', 'P2G', '', 'EXPEDITE', 'Ready for QA', 'Expedites'),
  ('Graupe', 'Louise A.', 'Wego 10A', 'SL', '2026-05-05', 'TC', '', 'EXPEDITE', 'Ready for QA', 'Expedites'),
  ('Doe', 'jordan', 'Talk pad 10', 'CL', '2026-05-05', 'Grid, TC', 'SC 50 KG', 'EXPEDITE', 'Ready for Pre-Prep', 'Expedites'),
  ('Doe', 'Jason', 'Grid Pad Go', 'LTL', '2026-05-05', 'Grid', '', 'Normal', 'Ready for Pre-Prep', 'Daily Queue')
on conflict do nothing;
