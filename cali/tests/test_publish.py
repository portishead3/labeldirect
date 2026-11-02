from bot.publish import customer_files, plan_delivery, website_reference


def test_website_reference_reads_the_order_line():
    text = "Order: LD-ATRWEQ\nCarrier: FedEx\n\nName: Jane Doe"
    assert website_reference(text) == "LD-ATRWEQ"
    assert website_reference("Adam yafid\n3 southwark street") is None


def test_customer_files_skip_the_transaction_record(tmp_path):
    label = tmp_path / "label.pdf"
    invoice = tmp_path / "invoice.pdf"
    record = tmp_path / "record.pdf"
    for path in (label, invoice, record):
        path.write_bytes(b"%PDF")
    files = customer_files(
        [
            {"kind": "label", "file_path": str(label)},
            {"kind": "invoice", "file_path": str(invoice)},
            {"kind": "record", "file_path": str(record)},
            {"kind": "other_9", "file_path": str(record)},
        ]
    )
    assert set(files) == {"label", "invoice"}


def test_first_reply_sends_label_and_invoice_but_not_the_record():
    files = {"label": "label.pdf", "invoice": "invoice.pdf", "record": "record.pdf"}
    chosen, edited = plan_delivery(files, [], set())
    assert set(chosen) == {"label", "invoice"}
    assert edited is False


def test_a_later_label_is_an_edit_and_only_that_label_is_sent():
    files = {"label": "label.pdf", "invoice": "invoice.pdf"}
    notes = ["Replaced the previous label."]
    chosen, edited = plan_delivery(files, notes, {"label", "invoice"})
    assert set(chosen) == {"label"}
    assert edited is True


def test_a_later_record_sends_nothing():
    files = {"label": "label.pdf", "invoice": "invoice.pdf"}
    chosen, edited = plan_delivery(files, ["Replaced the previous record."], {"label", "invoice"})
    assert chosen == {}
    assert edited is False
