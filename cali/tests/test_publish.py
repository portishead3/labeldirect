from bot.publish import customer_files, website_reference


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
