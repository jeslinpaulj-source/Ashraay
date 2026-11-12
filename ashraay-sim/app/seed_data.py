"""Seed data for the simulator.

IMPORTANT: names, rivers and locations follow CWC-style flood-forecast and
reservoir sites and real city wards, but every level (warning / danger / HFL /
FRL / MDDL / current) and every weather value is an APPROXIMATE or GENERATED
SEED VALUE for simulation only. Replace with official CWC / IMD / state data
before using numbers for anything real.

Level station tuple:
  (id, name, river, basin, state, district, lat, lon, warning_level, danger_level, hfl, seed_state)
  seed_state: N normal, A above-normal, S severe, E extreme  (sets the starting level)
Reservoir tuple:
  (id, name, river, basin, state, district, lat, lon, frl, mddl, live_capacity_mcm, seed_fill_pct)
"""

LEVEL_STATIONS = [
    # ---- Ganga ----
    ("GNG-HDW", "Haridwar", "Ganga", "Ganga", "Uttarakhand", "Haridwar", 29.945, 78.164, 293.00, 294.00, 296.30, "N"),
    ("GNG-FTG", "Fatehgarh", "Ganga", "Ganga", "Uttar Pradesh", "Farrukhabad", 27.390, 79.630, 136.60, 137.60, 138.90, "N"),
    ("GNG-PRY", "Prayagraj (Chhatnag)", "Ganga", "Ganga", "Uttar Pradesh", "Prayagraj", 25.420, 81.890, 83.73, 84.73, 88.03, "N"),
    ("GNG-VNS", "Varanasi", "Ganga", "Ganga", "Uttar Pradesh", "Varanasi", 25.318, 83.020, 70.26, 71.26, 73.90, "N"),
    ("GNG-GZP", "Ghazipur", "Ganga", "Ganga", "Uttar Pradesh", "Ghazipur", 25.580, 83.580, 62.11, 63.11, 65.22, "A"),
    ("GNG-BLA", "Ballia", "Ganga", "Ganga", "Uttar Pradesh", "Ballia", 25.760, 84.150, 56.62, 57.62, 60.39, "A"),
    ("GNG-BXR", "Buxar", "Ganga", "Ganga", "Bihar", "Buxar", 25.570, 83.980, 59.32, 60.32, 62.09, "A"),
    ("GNG-PTN", "Patna (Gandhighat)", "Ganga", "Ganga", "Bihar", "Patna", 25.620, 85.170, 47.60, 48.60, 50.52, "S"),
    ("GNG-HTD", "Hathidah", "Ganga", "Ganga", "Bihar", "Patna", 25.370, 85.990, 40.76, 41.76, 43.17, "A"),
    ("GNG-BGP", "Bhagalpur", "Ganga", "Ganga", "Bihar", "Bhagalpur", 25.270, 87.010, 32.68, 33.68, 34.86, "N"),
    ("GNG-KHL", "Kahalgaon", "Ganga", "Ganga", "Bihar", "Bhagalpur", 25.260, 87.230, 30.09, 31.09, 32.87, "N"),
    ("GNG-SBG", "Sahibganj", "Ganga", "Ganga", "Jharkhand", "Sahibganj", 25.250, 87.640, 26.25, 27.25, 30.91, "N"),
    ("GNG-FRK", "Farakka", "Ganga", "Ganga", "West Bengal", "Murshidabad", 24.800, 87.920, 21.25, 22.25, 25.14, "N"),
    # ---- Yamuna ----
    ("YMN-DLI", "Delhi Railway Bridge", "Yamuna", "Ganga", "Delhi", "Central Delhi", 28.660, 77.240, 204.50, 205.33, 208.66, "N"),
    ("YMN-MTR", "Mathura", "Yamuna", "Ganga", "Uttar Pradesh", "Mathura", 27.500, 77.690, 164.20, 165.20, 169.73, "N"),
    ("YMN-AGR", "Agra", "Yamuna", "Ganga", "Uttar Pradesh", "Agra", 27.180, 78.020, 151.40, 152.40, 154.76, "N"),
    ("YMN-ETW", "Etawah", "Yamuna", "Ganga", "Uttar Pradesh", "Etawah", 26.770, 79.020, 120.92, 121.92, 126.13, "N"),
    # ---- Ghaghra / Rapti ----
    ("GHG-ELG", "Elgin Bridge", "Ghaghra", "Ganga", "Uttar Pradesh", "Barabanki", 27.100, 81.480, 105.07, 106.07, 107.18, "A"),
    ("GHG-AYD", "Ayodhya", "Ghaghra", "Ganga", "Uttar Pradesh", "Ayodhya", 26.800, 82.200, 91.73, 92.73, 94.01, "N"),
    ("GHG-TRT", "Turtipar", "Ghaghra", "Ganga", "Uttar Pradesh", "Ballia", 26.150, 84.120, 63.01, 64.01, 66.00, "N"),
    ("RPT-BHN", "Birdghat (Gorakhpur)", "Rapti", "Ganga", "Uttar Pradesh", "Gorakhpur", 26.760, 83.370, 73.98, 74.98, 77.54, "N"),
    # ---- Bihar tributaries ----
    ("GDK-DMR", "Dumariaghat", "Gandak", "Ganga", "Bihar", "Gopalganj", 26.540, 84.300, 61.22, 62.22, 64.10, "A"),
    ("GDK-HJP", "Hajipur", "Gandak", "Ganga", "Bihar", "Vaishali", 25.690, 85.210, 49.32, 50.32, 50.93, "N"),
    ("KSI-BLT", "Baltara", "Kosi", "Ganga", "Bihar", "Khagaria", 25.480, 86.760, 32.85, 33.85, 36.40, "S"),
    ("KSI-BSU", "Basua", "Kosi", "Ganga", "Bihar", "Supaul", 26.100, 86.640, 46.75, 47.75, 49.30, "A"),
    ("BGM-BNB", "Benibad", "Bagmati", "Ganga", "Bihar", "Muzaffarpur", 26.020, 85.700, 47.68, 48.68, 50.01, "S"),
    ("BRG-SKD", "Sikandarpur", "Burhi Gandak", "Ganga", "Bihar", "Muzaffarpur", 26.130, 85.380, 51.53, 52.53, 54.29, "N"),
    ("BRG-KGR", "Khagaria", "Burhi Gandak", "Ganga", "Bihar", "Khagaria", 25.500, 86.480, 35.58, 36.58, 39.22, "A"),
    ("KML-JJP", "Jhanjharpur", "Kamla Balan", "Ganga", "Bihar", "Madhubani", 26.270, 86.280, 49.00, 50.00, 53.01, "N"),
    ("ADW-KTL", "Kamtaul", "Adhwara", "Ganga", "Bihar", "Darbhanga", 26.240, 85.900, 49.00, 50.00, 52.99, "N"),
    ("MHN-DHG", "Dhengraghat", "Mahananda", "Ganga", "Bihar", "Purnia", 25.780, 87.640, 34.65, 35.65, 38.92, "N"),
    # ---- Brahmaputra & Barak ----
    ("BRP-DBR", "Dibrugarh", "Brahmaputra", "Brahmaputra", "Assam", "Dibrugarh", 27.480, 94.910, 104.24, 105.70, 106.48, "A"),
    ("BRP-NMT", "Neamatighat", "Brahmaputra", "Brahmaputra", "Assam", "Jorhat", 26.830, 94.250, 84.04, 85.04, 87.37, "S"),
    ("BRP-TZP", "Tezpur", "Brahmaputra", "Brahmaputra", "Assam", "Sonitpur", 26.620, 92.800, 64.23, 65.23, 66.59, "A"),
    ("BRP-GHY", "Guwahati (DC Court)", "Brahmaputra", "Brahmaputra", "Assam", "Kamrup Metropolitan", 26.190, 91.750, 48.68, 49.68, 51.46, "A"),
    ("BRP-GLP", "Goalpara", "Brahmaputra", "Brahmaputra", "Assam", "Goalpara", 26.170, 90.620, 35.27, 36.27, 37.43, "N"),
    ("BRP-DHB", "Dhubri", "Brahmaputra", "Brahmaputra", "Assam", "Dhubri", 26.020, 89.980, 27.62, 28.62, 30.36, "N"),
    ("SBN-BDT", "Badatighat", "Subansiri", "Brahmaputra", "Assam", "Lakhimpur", 27.300, 94.190, 81.53, 82.53, 86.12, "N"),
    ("JBR-NTR", "NT Road Crossing", "Jia Bharali", "Brahmaputra", "Assam", "Sonitpur", 26.700, 92.880, 76.00, 77.00, 78.97, "E"),
    ("MNS-NHX", "Manas NH Crossing", "Manas", "Brahmaputra", "Assam", "Barpeta", 26.470, 90.960, 47.62, 48.10, 50.08, "N"),
    ("BKI-RDB", "Beki Road Bridge", "Beki", "Brahmaputra", "Assam", "Barpeta", 26.430, 91.010, 44.10, 45.10, 46.90, "A"),
    ("PTM-NHX", "Puthimari NH Crossing", "Puthimari", "Brahmaputra", "Assam", "Kamrup", 26.330, 91.580, 50.08, 51.08, 53.20, "N"),
    ("BRK-SLC", "Annapurna Ghat (Silchar)", "Barak", "Barak", "Assam", "Cachar", 24.820, 92.800, 19.83, 20.27, 21.84, "A"),
    ("TST-DMH", "Domohani", "Teesta", "Brahmaputra", "West Bengal", "Jalpaiguri", 26.560, 88.760, 85.65, 85.95, 87.10, "N"),
    ("TST-MKG", "Mekhliganj", "Teesta", "Brahmaputra", "West Bengal", "Cooch Behar", 26.340, 88.920, 65.45, 65.95, 67.20, "N"),
    # ---- Godavari / Krishna ----
    ("GDV-KLS", "Kaleshwaram", "Godavari", "Godavari", "Telangana", "Jayashankar Bhupalpally", 18.810, 79.910, 103.50, 104.75, 107.05, "N"),
    ("GDV-PRR", "Perur", "Godavari", "Godavari", "Telangana", "Mulugu", 18.550, 80.370, 86.00, 87.50, 90.89, "N"),
    ("GDV-BCM", "Bhadrachalam", "Godavari", "Godavari", "Telangana", "Bhadradri Kothagudem", 17.670, 80.890, 45.72, 48.77, 55.66, "A"),
    ("GDV-PLV", "Polavaram", "Godavari", "Godavari", "Andhra Pradesh", "Eluru", 17.250, 81.640, 23.50, 25.72, 30.10, "N"),
    ("GDV-DWL", "Dowlaiswaram", "Godavari", "Godavari", "Andhra Pradesh", "East Godavari", 16.950, 81.780, 14.25, 15.25, 18.36, "N"),
    ("KRS-VJW", "Vijayawada (Prakasam Barrage)", "Krishna", "Krishna", "Andhra Pradesh", "NTR", 16.510, 80.600, 17.50, 18.50, 20.40, "N"),
    ("KRS-JMK", "Jamkhandi", "Krishna", "Krishna", "Karnataka", "Bagalkot", 16.510, 75.300, 528.00, 529.50, 532.40, "N"),
    ("BHM-DGN", "Deongaon Bridge", "Bhima", "Krishna", "Karnataka", "Kalaburagi", 17.080, 76.650, 401.00, 402.50, 405.80, "N"),
    ("TGB-MNT", "Mantralayam", "Tungabhadra", "Krishna", "Andhra Pradesh", "Kurnool", 15.940, 77.430, 310.00, 312.00, 316.40, "N"),
    # ---- Mahanadi & east coast ----
    ("MHD-NRJ", "Naraj", "Mahanadi", "Mahanadi", "Odisha", "Cuttack", 20.470, 85.770, 25.41, 26.41, 27.73, "N"),
    ("MHD-TKR", "Tikarapara", "Mahanadi", "Mahanadi", "Odisha", "Angul", 20.600, 84.780, 63.00, 64.00, 66.80, "N"),
    ("BTR-AKP", "Akhuapada", "Baitarani", "Brahmani-Baitarani", "Odisha", "Bhadrak", 20.900, 86.330, 17.83, 18.33, 20.30, "N"),
    ("BRH-JNP", "Jenapur", "Brahmani", "Brahmani-Baitarani", "Odisha", "Jajpur", 20.880, 86.020, 22.00, 23.00, 24.85, "N"),
    ("SBR-RJG", "Rajghat", "Subarnarekha", "Subarnarekha", "Odisha", "Balasore", 21.570, 87.130, 9.45, 10.36, 12.60, "N"),
    # ---- Narmada / Tapi / west ----
    ("NMD-MDL", "Mandla", "Narmada", "Narmada", "Madhya Pradesh", "Mandla", 22.600, 80.370, 437.00, 438.50, 441.70, "N"),
    ("NMD-HSB", "Narmadapuram (Hoshangabad)", "Narmada", "Narmada", "Madhya Pradesh", "Narmadapuram", 22.760, 77.720, 292.83, 293.83, 300.90, "N"),
    ("NMD-GRD", "Garudeshwar", "Narmada", "Narmada", "Gujarat", "Narmada", 21.880, 73.650, 30.48, 31.09, 41.65, "N"),
    ("NMD-BRC", "Bharuch (Golden Bridge)", "Narmada", "Narmada", "Gujarat", "Bharuch", 21.700, 73.010, 6.71, 7.31, 10.40, "N"),
    ("TPI-SRT", "Surat (Hope Bridge)", "Tapi", "Tapi", "Gujarat", "Surat", 21.190, 72.820, 8.50, 9.50, 12.10, "N"),
    ("SBM-AMD", "Ahmedabad (Subhash Bridge)", "Sabarmati", "Sabarmati", "Gujarat", "Ahmedabad", 23.070, 72.590, 44.00, 45.34, 47.60, "N"),
    ("MHI-WNK", "Wanakbori", "Mahi", "Mahi", "Gujarat", "Kheda", 22.870, 73.360, 70.00, 71.50, 75.00, "N"),
    # ---- South ----
    ("CVR-KDM", "Kodumudi", "Cauvery", "Cauvery", "Tamil Nadu", "Erode", 11.080, 77.880, 120.50, 122.00, 124.30, "N"),
    ("CVR-MSR", "Musiri", "Cauvery", "Cauvery", "Tamil Nadu", "Tiruchirappalli", 10.950, 78.440, 70.50, 72.00, 74.20, "N"),
    ("CVR-TNP", "T. Narasipura", "Cauvery", "Cauvery", "Karnataka", "Mysuru", 12.210, 76.900, 640.00, 641.50, 644.10, "N"),
    ("NTV-BTW", "Bantwal", "Netravathi", "West Flowing Rivers", "Karnataka", "Dakshina Kannada", 12.890, 75.030, 7.50, 8.50, 11.20, "A"),
    ("PMB-MLK", "Malakkara", "Pamba", "West Flowing Rivers", "Kerala", "Pathanamthitta", 9.320, 76.640, 9.00, 10.00, 12.50, "N"),
    ("PRY-NLS", "Neeleswaram", "Periyar", "West Flowing Rivers", "Kerala", "Ernakulam", 10.180, 76.480, 9.50, 10.50, 13.10, "N"),
    ("BHR-KMB", "Kumbidi", "Bharathapuzha", "West Flowing Rivers", "Kerala", "Palakkad", 10.820, 76.020, 7.00, 8.00, 10.40, "N"),
    # ---- North ----
    ("JLM-SGM", "Sangam", "Jhelum", "Indus", "Jammu and Kashmir", "Anantnag", 33.770, 75.150, 1590.48, 1591.24, 1593.90, "N"),
    ("JLM-RMB", "Ram Munshi Bagh", "Jhelum", "Indus", "Jammu and Kashmir", "Srinagar", 34.070, 74.830, 1584.20, 1585.10, 1587.40, "N"),
    ("CHN-AKN", "Akhnoor", "Chenab", "Indus", "Jammu and Kashmir", "Jammu", 32.890, 74.740, 300.50, 302.00, 305.60, "N"),
    ("STJ-RPR", "Ropar", "Sutlej", "Indus", "Punjab", "Rupnagar", 30.970, 76.530, 259.00, 260.50, 263.30, "N"),
]

RESERVOIRS = [
    ("RSV-KRS", "Krishna Raja Sagara (KRS)", "Cauvery", "Cauvery", "Karnataka", "Mandya", 12.420, 76.570, 752.48, 728.00, 1163, 78),
    ("RSV-KBN", "Kabini", "Kabini", "Cauvery", "Karnataka", "Mysuru", 11.970, 76.350, 696.16, 680.00, 444, 92),
    ("RSV-HRG", "Harangi", "Harangi", "Cauvery", "Karnataka", "Kodagu", 12.490, 75.910, 871.42, 853.00, 220, 70),
    ("RSV-HMV", "Hemavathi", "Hemavathi", "Cauvery", "Karnataka", "Hassan", 12.780, 76.010, 890.63, 868.00, 1050, 74),
    ("RSV-TBD", "Tungabhadra", "Tungabhadra", "Krishna", "Karnataka", "Vijayanagara", 15.270, 76.330, 497.74, 477.01, 3276, 85),
    ("RSV-ALM", "Almatti (Lal Bahadur Shastri)", "Krishna", "Krishna", "Karnataka", "Vijayapura", 16.330, 75.890, 519.60, 505.97, 3105, 88),
    ("RSV-NRP", "Narayanpur (Basava Sagar)", "Krishna", "Krishna", "Karnataka", "Yadgir", 16.230, 76.360, 492.25, 488.00, 860, 66),
    ("RSV-LNG", "Linganamakki", "Sharavathi", "West Flowing Rivers", "Karnataka", "Shivamogga", 14.180, 74.850, 554.43, 522.73, 4294, 61),
    ("RSV-SUP", "Supa", "Kali", "West Flowing Rivers", "Karnataka", "Uttara Kannada", 15.270, 74.520, 564.00, 495.00, 4119, 55),
    ("RSV-BDR", "Bhadra", "Bhadra", "Krishna", "Karnataka", "Chikkamagaluru", 13.700, 75.640, 657.76, 627.00, 1785, 72),
    ("RSV-HSG", "Hesaraghatta", "Arkavathi", "Cauvery", "Karnataka", "Bengaluru Urban", 13.140, 77.480, 863.00, 857.00, 25, 40),
    ("RSV-TGH", "Thippagondanahalli (T.G. Halli)", "Arkavathi", "Cauvery", "Karnataka", "Ramanagara", 12.970, 77.330, 776.00, 765.00, 85, 52),
    ("RSV-IDK", "Idukki", "Periyar", "West Flowing Rivers", "Kerala", "Idukki", 9.840, 76.970, 732.43, 694.94, 1460, 81),
    ("RSV-MLP", "Mullaperiyar", "Periyar", "West Flowing Rivers", "Kerala", "Idukki", 9.530, 77.140, 46.33, 31.70, 300, 87),
    ("RSV-IDM", "Idamalayar", "Idamalayar", "West Flowing Rivers", "Kerala", "Ernakulam", 10.220, 76.700, 169.00, 115.00, 1018, 69),
    ("RSV-KKI", "Kakki", "Pamba", "West Flowing Rivers", "Kerala", "Pathanamthitta", 9.330, 77.140, 981.46, 908.30, 447, 64),
    ("RSV-MTR", "Mettur (Stanley)", "Cauvery", "Cauvery", "Tamil Nadu", "Salem", 11.800, 77.810, 240.79, 211.84, 2647, 83),
    ("RSV-BHV", "Bhavanisagar", "Bhavani", "Cauvery", "Tamil Nadu", "Erode", 11.470, 77.110, 278.89, 256.03, 929, 71),
    ("RSV-VGI", "Vaigai", "Vaigai", "Vaigai", "Tamil Nadu", "Theni", 10.050, 77.590, 279.20, 263.00, 172, 58),
    ("RSV-SRS", "Srisailam", "Krishna", "Krishna", "Andhra Pradesh", "Nandyal", 16.090, 78.900, 269.75, 243.84, 8288, 90),
    ("RSV-SMS", "Somasila", "Penna", "Pennar", "Andhra Pradesh", "Nellore", 14.480, 79.300, 100.58, 82.30, 1994, 63),
    ("RSV-NJS", "Nagarjuna Sagar", "Krishna", "Krishna", "Telangana", "Nalgonda", 16.580, 79.310, 179.83, 149.35, 6841, 79),
    ("RSV-SRSP", "Sriram Sagar", "Godavari", "Godavari", "Telangana", "Nizamabad", 18.960, 78.340, 332.54, 321.00, 2300, 75),
    ("RSV-KYN", "Koyna", "Koyna", "Krishna", "Maharashtra", "Satara", 17.400, 73.750, 657.91, 609.60, 2836, 84),
    ("RSV-JKW", "Jayakwadi", "Godavari", "Godavari", "Maharashtra", "Chhatrapati Sambhajinagar", 19.480, 75.370, 463.91, 455.52, 2171, 62),
    ("RSV-UJN", "Ujani", "Bhima", "Krishna", "Maharashtra", "Solapur", 18.070, 75.120, 496.83, 491.03, 1517, 76),
    ("RSV-SSP", "Sardar Sarovar", "Narmada", "Narmada", "Gujarat", "Narmada", 21.830, 73.750, 138.68, 110.64, 5760, 86),
    ("RSV-UKI", "Ukai", "Tapi", "Tapi", "Gujarat", "Tapi", 21.250, 73.590, 105.16, 82.30, 6720, 80),
    ("RSV-KDN", "Kadana", "Mahi", "Mahi", "Gujarat", "Mahisagar", 23.300, 73.830, 127.71, 110.00, 1249, 67),
    ("RSV-ISP", "Indira Sagar", "Narmada", "Narmada", "Madhya Pradesh", "Khandwa", 22.280, 76.470, 262.13, 243.23, 9745, 82),
    ("RSV-GSG", "Gandhi Sagar", "Chambal", "Ganga", "Madhya Pradesh", "Mandsaur", 24.700, 75.550, 399.90, 381.00, 6827, 60),
    ("RSV-BRG", "Bargi (Rani Avanti Bai Sagar)", "Narmada", "Narmada", "Madhya Pradesh", "Jabalpur", 22.950, 79.930, 422.76, 403.55, 3180, 77),
    ("RSV-MMB", "Minimata Bango", "Hasdeo", "Mahanadi", "Chhattisgarh", "Korba", 22.610, 82.600, 359.66, 329.79, 2894, 65),
    ("RSV-GNG", "Gangrel (Ravishankar Sagar)", "Mahanadi", "Mahanadi", "Chhattisgarh", "Dhamtari", 20.620, 81.560, 348.70, 337.90, 767, 70),
    ("RSV-HKD", "Hirakud", "Mahanadi", "Mahanadi", "Odisha", "Sambalpur", 21.520, 83.870, 192.02, 179.83, 5378, 87),
    ("RSV-RNG", "Rengali", "Brahmani", "Brahmani-Baitarani", "Odisha", "Angul", 21.280, 85.030, 123.50, 109.72, 3432, 74),
    ("RSV-IDV", "Upper Indravati", "Indravati", "Godavari", "Odisha", "Nabarangpur", 19.270, 82.830, 642.00, 625.00, 1456, 68),
    ("RSV-MTN", "Maithon", "Barakar", "Ganga", "Jharkhand", "Dhanbad", 23.780, 86.810, 146.30, 129.54, 612, 79),
    ("RSV-PNC", "Panchet", "Damodar", "Ganga", "Jharkhand", "Dhanbad", 23.680, 86.750, 124.97, 119.48, 184, 83),
    ("RSV-TNG", "Tenughat", "Damodar", "Ganga", "Jharkhand", "Bokaro", 23.730, 85.840, 269.14, 255.00, 821, 59),
    ("RSV-BKR", "Bhakra (Gobind Sagar)", "Sutlej", "Indus", "Himachal Pradesh", "Bilaspur", 31.410, 76.430, 512.06, 445.62, 6229, 81),
    ("RSV-PNG", "Pong", "Beas", "Indus", "Himachal Pradesh", "Kangra", 31.970, 75.950, 423.67, 384.05, 6157, 77),
    ("RSV-RSD", "Ranjit Sagar (Thein)", "Ravi", "Indus", "Punjab", "Pathankot", 32.440, 75.730, 527.91, 487.68, 2344, 73),
    ("RSV-THR", "Tehri", "Bhagirathi", "Ganga", "Uttarakhand", "Tehri Garhwal", 30.380, 78.480, 830.00, 740.00, 2615, 88),
    ("RSV-RHD", "Rihand (Govind Ballabh Pant Sagar)", "Rihand", "Ganga", "Uttar Pradesh", "Sonbhadra", 24.200, 83.000, 268.22, 252.98, 5649, 64),
    ("RSV-MTL", "Matatila", "Betwa", "Ganga", "Uttar Pradesh", "Lalitpur", 25.100, 78.380, 308.46, 297.00, 707, 71),
    ("RSV-RPS", "Rana Pratap Sagar", "Chambal", "Ganga", "Rajasthan", "Chittorgarh", 24.920, 75.580, 352.81, 343.81, 1566, 69),
    ("RSV-MBS", "Mahi Bajaj Sagar", "Mahi", "Mahi", "Rajasthan", "Banswara", 23.630, 74.550, 281.50, 260.00, 1711, 66),
    ("RSV-BSL", "Bisalpur", "Banas", "Ganga", "Rajasthan", "Tonk", 25.920, 75.460, 315.50, 298.00, 1076, 57),
]

# ---- Weather: city wards (approximate centre points). Districts without a ward list
# get one "District HQ" forecast point placed at the mean of its stations/dams. ----
WARDS = {
    ("Karnataka", "Bengaluru Urban"): [
        ("Bellandur", 12.926, 77.676), ("Varthur", 12.940, 77.746), ("Marathahalli", 12.956, 77.701),
        ("HSR Layout", 12.912, 77.638), ("Koramangala", 12.935, 77.624), ("Whitefield", 12.970, 77.750),
        ("Mahadevapura", 12.990, 77.690), ("KR Puram", 13.007, 77.696), ("Indiranagar", 12.978, 77.640),
        ("Hebbal", 13.035, 77.597), ("Yelahanka", 13.100, 77.596), ("Malleshwaram", 13.003, 77.570),
        ("Rajajinagar", 12.991, 77.552), ("Yeshwanthpur", 13.028, 77.540), ("Shivajinagar", 12.985, 77.605),
        ("Jayanagar", 12.925, 77.583), ("Basavanagudi", 12.942, 77.575), ("BTM Layout", 12.916, 77.610),
        ("Bommanahalli", 12.905, 77.623), ("Electronic City", 12.845, 77.660), ("Kengeri", 12.912, 77.483),
    ],
    ("Tamil Nadu", "Chennai"): [
        ("Velachery", 12.976, 80.221), ("T. Nagar", 13.042, 80.234), ("Adyar", 13.001, 80.256),
        ("Anna Nagar", 13.085, 80.210), ("Saidapet", 13.021, 80.223), ("Perungudi", 12.960, 80.240),
        ("Tambaram", 12.925, 80.127), ("Mudichur", 12.910, 80.070),
    ],
    ("Maharashtra", "Mumbai Suburban"): [
        ("Andheri", 19.119, 72.847), ("Kurla", 19.072, 72.879), ("Bandra", 19.054, 72.840),
        ("Borivali", 19.229, 72.857), ("Chembur", 19.062, 72.900),
    ],
    ("Maharashtra", "Mumbai City"): [("Dadar", 19.018, 72.844), ("Sion", 19.040, 72.862), ("Colaba", 18.907, 72.815)],
    ("Telangana", "Hyderabad"): [
        ("Kukatpally", 17.494, 78.399), ("LB Nagar", 17.346, 78.552), ("Secunderabad", 17.439, 78.498),
        ("Gachibowli", 17.440, 78.348), ("Malakpet", 17.372, 78.500), ("Mehdipatnam", 17.396, 78.432),
    ],
    ("Bihar", "Patna"): [
        ("Kankarbagh", 25.594, 85.155), ("Rajendra Nagar", 25.604, 85.162), ("Danapur", 25.627, 85.047),
        ("Patna City", 25.597, 85.218), ("Boring Road", 25.616, 85.115),
    ],
    ("Assam", "Kamrup Metropolitan"): [
        ("Anil Nagar", 26.170, 91.770), ("Zoo Road", 26.177, 91.775), ("Dispur", 26.140, 91.790),
        ("Maligaon", 26.157, 91.700), ("Beltola", 26.125, 91.800),
    ],
    ("Kerala", "Ernakulam"): [
        ("Edappally", 10.025, 76.308), ("Kakkanad", 10.016, 76.341), ("Fort Kochi", 9.965, 76.243),
        ("Vyttila", 9.967, 76.318), ("Aluva", 10.108, 76.351),
    ],
    ("West Bengal", "Kolkata"): [
        ("Behala", 22.498, 88.310), ("Salt Lake", 22.580, 88.415), ("Garden Reach", 22.545, 88.290),
        ("Kasba", 22.515, 88.385), ("Tollygunge", 22.498, 88.346),
    ],
    ("Delhi", "Central Delhi"): [("Yamuna Bazaar", 28.660, 77.235), ("Daryaganj", 28.645, 77.240), ("Civil Lines", 28.680, 77.225)],
    ("Delhi", "East Delhi"): [("Mayur Vihar", 28.607, 77.293), ("Laxmi Nagar", 28.630, 77.278), ("Shahdara", 28.673, 77.289)],
}

# State climatology used only to GENERATE plausible seed forecasts:
# (probability of a wet day, mean rain on a wet day in mm, typical max temperature C)
STATE_CLIMATE = {
    "Kerala": (0.75, 30, 30), "Karnataka": (0.55, 20, 29), "Assam": (0.70, 28, 31),
    "Maharashtra": (0.60, 25, 30), "Tamil Nadu": (0.50, 22, 32), "Andhra Pradesh": (0.45, 15, 33),
    "Telangana": (0.45, 14, 32), "Odisha": (0.55, 20, 32), "West Bengal": (0.55, 20, 32),
    "Bihar": (0.50, 18, 33), "Jharkhand": (0.50, 16, 31), "Uttar Pradesh": (0.40, 14, 33),
    "Uttarakhand": (0.55, 20, 26), "Himachal Pradesh": (0.50, 16, 24), "Jammu and Kashmir": (0.35, 10, 25),
    "Punjab": (0.30, 10, 33), "Delhi": (0.30, 12, 34), "Rajasthan": (0.20, 10, 36),
    "Gujarat": (0.40, 18, 33), "Madhya Pradesh": (0.45, 16, 31), "Chhattisgarh": (0.50, 18, 31),
}
DEFAULT_CLIMATE = (0.4, 15, 31)
