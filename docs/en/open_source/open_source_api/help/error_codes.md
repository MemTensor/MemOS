---
title: Error Codes
---

| Error Code | Meaning | Recommended Solution |
| :--- | :--- | :--- |
| **Parameter Errors** | | |
| 40000 | Invalid request parameters | Check parameter names, types, and formats |
| 40001 | Requested data not found | Verify the resource ID (e.g., memory_id) is correct |
| 40002 | Required parameter is empty | Provide the missing required fields |
| 40003 | Parameter is empty | Check whether the passed list or object is empty |
| 40006 | Unsupported type | Check the value of the type field |
| 40007 | Unsupported file type | Only upload allowed formats (.pdf, .docx, .doc, .txt) |
| 40008 | Invalid Base64 content | Check if the Base64 string contains invalid characters |
| 40009 | Invalid Base64 format | Verify the Base64 encoding format is correct |
| 40010 | User ID too long | user_id must not exceed 100 characters |
| 40011 | Conversation ID too long | conversation_id must not exceed 100 characters |
| 40020 | Invalid project ID | Verify the project ID format |
| **Authentication & Authorization Errors** | | |
| 40100 | API Key authentication required | Add a valid API Key to the Header |
| 40130 | API Key authentication required | Add a valid API Key to the Header |
| 40132 | Invalid or expired API Key | Check the API Key status or regenerate it |
| **Quota & Rate Limit Errors** | | |
| 40300 | API call quota exceeded | Reduce request frequency or contact the administrator to increase the quota |
| 40301 | Request token limit exceeded | Reduce input content or get more quota |
| 40302 | Response token limit exceeded | Shorten expected output or get more quota |
| 40303 | Single conversation length exceeded | Reduce the single input/output length |
| 40304 | Account API call limit exhausted | Reduce request frequency or contact the administrator to increase the quota |
| 40305 | Input exceeds single token limit | Reduce input content |
| 40306 | Delete memory authorization failed | Confirm you have permission to delete this memory |
| 40307 | Memory to delete not found | Check if the memory_id is valid |
| 40308 | User associated with memory not found | Check if the user_id is correct |
| **System & Service Errors** | | |
| 50000 | Internal system error | Server is busy or encountered an error, contact support |
| 50002 | Operation failed | Check the operation logic or retry later |
| 50004 | Memory service temporarily unavailable | Retry the memory write/read operation later |
| 50005 | Search service temporarily unavailable | Retry the memory search operation later |
| **Knowledge Base & Operation Errors** | | |
| 50103 | File count limit exceeded | Upload no more than 20 files at once |
| 50104 | Single file size limit exceeded | Ensure each file does not exceed 100MB |
| 50105 | Total file size limit exceeded | Ensure total upload size does not exceed 300MB |
| 50107 | File upload format does not meet requirements | Check and change the file format |
| 50120 | Knowledge base does not exist | Verify the knowledge base ID is correct |
| 50123 | Knowledge base not linked to this project | Confirm the knowledge base is authorized for the current project |
| 50131 | Task not found | Check the task_id (common when querying processing status) |
| 50143 | Add memory failed | Algorithm service processing error, please retry later |
| 50144 | Add message failed | Failed to save chat history |
| 50145 | Save feedback and write memory failed | An error occurred during feedback processing |
